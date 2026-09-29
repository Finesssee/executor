## App data

Use the same author schemas for scalar database columns. Declare requirements once, derive `QueryContext<typeof requirements>` and
`MutationContext<typeof requirements>`, and use the standalone `query` and
`mutation` functions. External handlers annotate their context; inline handlers
infer it from `defineApp`. Input and output types remain inferred from schemas.

```ts
import {
  query,
  mutation,
  type QueryContext,
  type MutationContext,
  defineApp,
  defineDatabase,
  json,
  object,
  string,
  table,
  router,
} from "apps";

const database = defineDatabase({
  messages: table({ mailbox: string(), subject: string() }).index("by_mailbox", ["mailbox"]),
});
const requirements = { accounts: {}, database };
const list = query(
  { input: object({ mailbox: string() }), output: json() },
  async ({ db }: QueryContext<typeof requirements>, { mailbox }) =>
    db.messages
      .withIndex("by_mailbox", (q) => q.eq("mailbox", mailbox))
      .order("desc")
      .take(50),
);
const add = mutation(
  { input: object({ mailbox: string(), subject: string() }), output: json() },
  async ({ db }: MutationContext<typeof requirements>, message) => db.messages.insert(message),
);
export default defineApp(requirements, {
  tools: router({
    list,
    add,
  }),
});
```

Queries and mutations in the app's `tools` router are automatically available to
the agent by their router path, such as `list` or `issues.list`. Use `tools.search`
to get their exact callable expressions; do not write another tool wrapper. Calls preserve
read-only query capability, atomic mutation commit, output validation and live
updates. Add `description` and optionally `title` to an operation's options to
improve discovery. Agent paths nest these under the name-derived app slug,
for example `tools.inbox.list(...)`.

`defineDatabase` supplies only the schema; `database.query` and `database.mutation`
are removed. Declaring a database gives every query a read session and every
mutation a write transaction. Interactive elicitation is unavailable during those
transactions. Browser clients can subscribe with query references/live atoms.

Use a concrete output schema instead of `json()` when you want inferred client
result fields. Each configured app has its own database, retained across code
updates. Never supply row metadata on writes: the host creates `id`, `createdAt`
and `updatedAt`. Those three names are reserved: a table that declares any of them
fails to deploy with `DatabaseFieldReserved`, naming the table and field. Use the
row's own metadata, or pick another name such as `publishedAt`. Tables also provide `get`, `update` and `delete`. Queries have
read methods only. Optional fields support `null` to clear them; defaults apply
when values are omitted. An undefined patch property leaves the value unchanged.

Index queries support prefix `eq` terms, then `gt`/`gte`/`lt`/`lte` bounds on the
next field. Use `by_creation` without declaring an index. Terminals include
`first`, `take`, `collect`, `count` and `paginate({ cursor, numItems })`. A page
returns `page`, `continueCursor`, and `isDone`. Pass the returned cursor unchanged.

Mutations commit only after output validation. External fetch is allowed in queries and mutations, but network waits inside
database callbacks keep their transaction open. Schema changes currently fail
closed; an explicit migration flow is not implemented yet. Rebuild old prototype
apps using `defineTable`/`db.set` for this API; no legacy-data migration is included.

## Limits

Each query or mutation invocation has fixed database budgets. Exceeding one fails
the whole invocation with `DatabaseLimitExceeded`; a mutation commits nothing. The
error's `limit` names the budget, with `maximum` and `requested`, and its message
explains the fix. Catching the rejection does not help: the session stays failed.

| `limit`        | Budget per invocation                                                        |
| -------------- | ---------------------------------------------------------------------------- |
| `scanCalls`    | 100 index queries: each `first`, `take`, `collect`, `count`, `paginate` call |
| `directGets`   | 1,000 `get(id)` calls; `update` and `delete` each make one                   |
| `rowsRead`     | 5,000 rows scanned                                                           |
| `rowsReturned` | 1,000 rows returned                                                          |
| `pageSize`     | 1,000 rows requested by one `take(n)` or `paginate({ numItems })`            |
| `bytesRead`    | 4 MiB read                                                                   |
| `writes`       | 1,000 inserts, updates and deletes                                           |
| `valueBytes`   | 64 KiB per stored row                                                        |

Rows count against `rowsReturned` as they are returned, so `take(200)` that
returns 7 rows leaves 993 for later calls. `collect` and `count` fail instead of
truncating.

The 100 index-query budget is the one most loops hit. Do not call `first()` once
per item:

```ts
// 1 index query instead of one per id.
const rows = await ctx.db.messages
  .withIndex("by_mailbox", (q) => q.eq("mailbox", mailbox))
  .take(500);
const byExternalId = new Map(rows.map((row) => [row.externalId, row]));
```

Read known IDs with `get(id)`, which has its own 1,000-call budget. For work larger
than one invocation, such as an ingest of thousands of rows, make a mutation that
handles one bounded batch and returns where to continue. Call it from a workflow
loop with `step.runMutation("batch-" + n, ingestBatch, { cursor })` until it
reports completion; see [workflows.md](workflows.md).

## Read and write results

`insert(value)` returns the complete inserted row, including `id`, `createdAt`
and `updatedAt`. `get(id)` returns a row or `null`. `update(id, patch)` returns
the updated row or `null` when the row does not exist. `delete(id)` returns a boolean. Read `DatabaseTable.insert`,
`DatabaseTable.update`, and `IndexQuery` through `framework.describe` for exact types.
Do not deploy probe apps to discover these contracts.
