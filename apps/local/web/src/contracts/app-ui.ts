import { dashboardHttpClient } from "@executor-js/ui/contracts/http";
import { AppAuthenticationApi } from "@executor-js/local-server/app-ui";
import { AtomHttpApi } from "effect/unstable/reactivity";

/** Dashboard identity authorizes a browser-bound attempt that began at an app URL. */
export class AppAuthenticationClient extends AtomHttpApi.Service<AppAuthenticationClient>()(
  "AppAuthenticationClient",
  {
    api: AppAuthenticationApi,
    httpClient: dashboardHttpClient,
  },
) {}
/** Exchange the current Executor login for an app-scoped callback. */
export const authorizeAppAtom = AppAuthenticationClient.mutation("appAuthentication", "authorize");
