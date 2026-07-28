import { defineConfig, loadEnv, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = (env.KRATER_API_URL || "http://127.0.0.1:4317").replace(/\/$/, "");

  return {
    // The workspace can hoist the React plugin alongside a newer Vite release.
    // Its runtime contract is compatible, while the duplicated Vite types are not.
    plugins: [react() as unknown as PluginOption],
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    build: {
      // Monaco's editor core is intentionally a separately loaded feature
      // chunk. It is not part of the initial application payload.
      chunkSizeWarningLimit: 4_100,
      rollupOptions: {
        output: {
          // Monaco remains behind AgenticIde's React.lazy boundary. Giving its
          // runtime a stable chunk prevents routine UI edits from invalidating
          // the large, locally bundled editor payload.
          manualChunks: {
            "monaco-editor": ["monaco-editor"],
          },
        },
      },
    },
  };
});
