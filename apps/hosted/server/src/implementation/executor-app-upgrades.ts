import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * One-off: ask every organization's default Executor app to move to the current template.
 * Member setup redeploys a copy only while the deployment Executor installed is still active
 * and its workspace has no unsaved edits; customized copies are left alone.
 *
 * Jobs start after a delay so the replacement server, not the one still serving during the
 * deployment, runs them. Append a new step when the template changes again.
 */
export const queueExecutorAppUpgrades = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`insert into hosted_provisioning (kind, organization_id, user_id, available_at)
    select distinct on (organization.id) 'member', organization.id, member."userId", now() + interval '15 minutes'
    from organization
    join member on member."organizationId" = organization.id and member.role in ('owner', 'admin')
    join "user" on "user".id = member."userId"
    where organization.metadata::jsonb -> 'executorDefaults' ->> 'deployment' is not null
    order by organization.id, "user"."emailVerified" desc, member.role = 'owner' desc, member."createdAt"`;
});
