/** Public build metadata compiled into every dashboard bundle by `vite.ts`. */
declare global {
  interface ImportMetaEnv {
    readonly VITE_EXECUTOR_BUILD: string;
    readonly VITE_EXECUTOR_ENVIRONMENT_NAME: string;
  }
}

export {};
