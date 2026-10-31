// The engine client: every request carries the CLI token from `<home>/token`
// (contracts/http-api.md). HTTP failures become exit codes (contracts/cli.md).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CliError, EXIT } from "./errors.ts";

export const DEFAULT_URL = "http://127.0.0.1:4807";

/** Reads the token without creating it: only `taskville serve` creates the home. */
export function readToken(home: string): string {
  const path = join(home, "token");
  let token: string;
  try {
    token = readFileSync(path, "utf8").trim();
  } catch {
    throw new CliError(
      EXIT.auth,
      `No token at ${path}; start the engine with \`taskville serve\` (or pass --home)`,
    );
  }
  if (token === "") throw new CliError(EXIT.auth, `The token file ${path} is empty`);
  return token;
}

export interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

export class EngineClient {
  readonly base: string;
  readonly #token: string;
  readonly #signal: AbortSignal | undefined;

  constructor(options: { url: string; token: string; signal?: AbortSignal | undefined }) {
    this.base = options.url.replace(/\/+$/, "");
    this.#token = options.token;
    this.#signal = options.signal;
  }

  /** Sends a request; returns the response for 2xx and throws a CliError otherwise. */
  async send(
    method: string,
    path: string,
    body?: unknown,
    accept = "application/json",
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: accept,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(this.#signal === undefined ? {} : { signal: this.#signal }),
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      throw new CliError(
        EXIT.unreachable,
        `Engine unreachable at ${this.base}; is \`taskville serve\` running?`,
      );
    }
    if (response.ok) return response;
    const payload = (await response.json().catch(() => ({}))) as ApiErrorBody;
    const code = payload.error?.code ?? `http_${response.status}`;
    const message = payload.error?.message ?? response.statusText;
    if (response.status === 401 || response.status === 403) {
      throw new CliError(EXIT.auth, `Not authorized (${code}): ${message}`);
    }
    if (code === "unknown_project" || code === "project_exists") {
      throw new CliError(EXIT.notFound, message);
    }
    throw new CliError(EXIT.failure, `Engine error ${response.status} (${code}): ${message}`);
  }

  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await (await this.send(method, path, body)).json()) as T;
  }
}

/** Raised by `events follow` and similar when the user interrupts. */
export const isAbort = (error: unknown): boolean =>
  (error as { name?: string } | null)?.name === "AbortError";
