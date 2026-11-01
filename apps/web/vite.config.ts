import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The engine the dev server forwards API calls to (`taskville serve`, default port 4807). */
const engine = process.env.TASKVILLE_ENGINE_URL ?? "http://127.0.0.1:4807";

// In production the engine serves the built files itself, on the same origin, so the page
// needs no proxy and no CORS. In development the Vite server stands in for that origin and
// forwards `/v1` and `/health` to the engine. The engine checks Host and Origin against its
// own loopback address, so the proxy rewrites both; it is a local development convenience and
// binds 127.0.0.1 only.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/v1": { target: engine, changeOrigin: true, configure: rewriteOrigin(engine) },
      "/health": { target: engine, changeOrigin: true, configure: rewriteOrigin(engine) },
    },
  },
});

function rewriteOrigin(target: string) {
  return (proxy: {
    on(
      event: "proxyReq",
      listener: (req: {
        getHeader(name: string): unknown;
        setHeader(name: string, value: string): void;
      }) => void,
    ): void;
  }) => {
    proxy.on("proxyReq", (req) => {
      if (req.getHeader("origin") !== undefined) req.setHeader("origin", new URL(target).origin);
    });
  };
}
