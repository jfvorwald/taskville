import pino from "pino";
import { PairingStore } from "../../src/auth/pairing.ts";
import { createApp } from "../../src/http/app.ts";

export const PORT = 4807;
export const HOST = `127.0.0.1:${PORT}`;
export const ORIGIN = `http://127.0.0.1:${PORT}`;
export const CLI_TOKEN = "cli-token-0123456789abcdefghijklmnopqrstuvwxyzAB";
export const BRIDGE_TOKEN = "bridge-token-0123456789abcdefghijklmnopqrstuvwxy";

export function makeApp(extra: { staticDir?: string } = {}) {
  const logLines: string[] = [];
  const logger = pino({ level: "debug" }, { write: (line: string) => logLines.push(line) });
  const pairing = new PairingStore();
  const app = createApp({
    port: PORT,
    cliToken: CLI_TOKEN,
    bridgeToken: BRIDGE_TOKEN,
    pairing,
    logger,
    ...extra,
  });
  return { app, pairing, logLines };
}

export function bearer(token: string): Record<string, string> {
  return { Host: HOST, Authorization: `Bearer ${token}` };
}

export function sessionHeaders(secret: string): Record<string, string> {
  return { Host: HOST, "X-Taskville-Session": secret };
}

export function postJson(body: unknown, headers: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}
