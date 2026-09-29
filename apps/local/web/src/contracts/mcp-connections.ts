/** The local operator's scoped connections, reconciled after each write. */
import { hydrated } from "@executor-js/ui/contracts/http";
import { Effect } from "effect";
import type { ConnectionId } from "@executor-js/mcp-auth/connections";
import type { ConnectionSave } from "@executor-js/ui/contracts/scoped-connections";
import { acknowledge, acknowledgedQuery, upsert } from "@executor-js/ui/contracts/mutations";
import { DashboardClient } from "./api.ts";

/** Keep confirmed connections visible while background reconciliation runs. */
export const mcpConnectionsAtom = DashboardClient.query(
  "mcpConnections",
  "list",
  hydrated({}),
).pipe(acknowledgedQuery);
/** Create with the editor's chosen ID, or replace an existing connection's name and access. */
export const saveMcpConnectionAtom = DashboardClient.runtime.fn(
  ({ existing, input }: ConnectionSave, get) =>
    Effect.gen(function* () {
      const client = yield* DashboardClient;
      const saved = existing
        ? yield* client.mcpConnections.update({
            params: { connection: input.id },
            payload: { name: input.name, apps: input.apps },
          })
        : yield* client.mcpConnections.create({ payload: input });
      acknowledge(get, mcpConnectionsAtom, (current) => upsert(current, saved));
      return saved;
    }),
);
/** Remove the row only after the server revoked the connection and its grants. */
export const revokeMcpConnectionAtom = DashboardClient.runtime.fn((connection: ConnectionId, get) =>
  Effect.flatMap(DashboardClient, (client) =>
    client.mcpConnections.revoke({ params: { connection } }),
  ).pipe(
    Effect.tap(() =>
      Effect.sync(() =>
        acknowledge(get, mcpConnectionsAtom, (current) =>
          current.filter((item) => item.id !== connection),
        ),
      ),
    ),
  ),
);
