import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import type { AppEnv } from "./middleware.ts";

/** The engine listens on IPv4 loopback only. Deliberately not configurable. */
export const LOOPBACK_ADDRESS = "127.0.0.1";

export interface RunningServer {
  address: string;
  port: number;
  close(): Promise<void>;
}

/** Starts the app on 127.0.0.1:`port`. Resolves once listening; rejects on a listen error. */
export function startServer(opts: { app: Hono<AppEnv>; port: number }): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const server = serve(
      { fetch: opts.app.fetch, hostname: LOOPBACK_ADDRESS, port: opts.port },
      (info) => {
        server.off("error", reject);
        resolve({
          address: info.address,
          port: info.port,
          close: () =>
            new Promise<void>((done, fail) => {
              server.close((err) => (err ? fail(err) : done()));
            }),
        });
      },
    );
    server.once("error", reject);
  });
}
