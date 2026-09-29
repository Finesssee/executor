import { dashboardStartPlugins } from "@executor-js/dashboard-start/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

// T3 Code uses bundled development to avoid cold ESM import waterfalls.
const desktopDevelopment = process.env.EXECUTOR_DESKTOP_DEV === "1";
const tailwind = tailwindcss();
if (desktopDevelopment) {
  // Rolldown tracks addWatchFile dependencies; this Vite-only hook expects ModuleNodes.
  for (const plugin of tailwind) delete plugin.hotUpdate;
}

export default defineConfig({
  experimental: { bundledDev: desktopDevelopment },
  // The local server and desktop app run the document renderer in Node.
  plugins: dashboardStartPlugins({ runtime: "node", tailwind }),
});
