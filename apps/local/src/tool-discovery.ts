import {
  createJevToolDiscoveryProvider,
  defaultToolDiscoveryProvider,
} from "@executor-js/execution";

/** Opt in only for the customized local server; other Executor hosts keep their defaults. */
export const localToolDiscoveryProvider =
  process.env.EXECUTOR_JEV_ROUTER === "1"
    ? createJevToolDiscoveryProvider()
    : defaultToolDiscoveryProvider;
