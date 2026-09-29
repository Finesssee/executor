/** Private local app origins and the sign-in identifiers they share with the dashboard. */
import { AppId } from "@executor-js/sdk";
export { AppSignInFailure, AppSignInId } from "apps/ui/auth/contracts";
/** DNS labels use the stable UUID, while SDK IDs retain their app_ prefix. */
export const appOrigin = (app: AppId, port: number) =>
  `http://${app.replace(/^app_/, "app-")}.localhost:${port}`;
/** Accept only generated local app hostnames, never arbitrary Host or forwarding headers. */
export const appFromHost = (host: string | undefined, port: number) => {
  const match = new RegExp(
    `^app-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\\.localhost:${port}$`,
  ).exec(host ?? "");
  return match?.[1] === undefined ? undefined : AppId.make(`app_${match[1]}`);
};
/** Port-specific name; cookies are host-only and never shared with the dashboard. */
export const appSessionCookie = (port: number) => `executor_app_${port}`;
