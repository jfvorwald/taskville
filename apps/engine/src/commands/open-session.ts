import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { OpenerValueError, renderOpener } from "../config/opener.ts";

// "Open session" (ARCHITECTURE.md): copy-only unless the owner configured an opener template.
// The template comes only from the engine config (config file or CLI), never from a request, and
// runs through execFile with an argument array, never a shell.

/** What a caller supplies. Anything else on the request, such as a template, is ignored. */
export interface OpenSessionRequest {
  sessionId: string;
  cwd: string;
}

/** The only template source: the loaded engine config. */
export interface OpenSessionConfig {
  sessionOpener: string[] | null;
}

/** `shell` is always false, so no argument is ever interpreted by a shell. */
export type OpenSessionExecOptions = { shell: false; windowsHide: true };

export type OpenSessionExecFile = (
  file: string,
  args: string[],
  options: OpenSessionExecOptions,
) => Promise<unknown>;

export interface OpenSessionDeps {
  config: OpenSessionConfig;
  execFile: OpenSessionExecFile;
}

export type OpenSessionResult =
  | { status: "copy-only" | "opened"; sessionId: string; cwd: string }
  | {
      status: "failed";
      reason: "invalid-value" | "spawn-failed";
      message: string;
      sessionId: string;
      cwd: string;
    };

/** The real `execFile` for `OpenSessionDeps`: promisified, with no shell. */
export const defaultExecFile: OpenSessionExecFile = promisify(nodeExecFile);

export async function openSession(
  request: OpenSessionRequest,
  deps: OpenSessionDeps,
): Promise<OpenSessionResult> {
  const { sessionId, cwd } = request;
  const template = deps.config.sessionOpener;
  if (template === null) return { status: "copy-only", sessionId, cwd };

  let command: { file: string; args: string[] };
  try {
    command = renderOpener(template, { sessionId, cwd });
  } catch (error) {
    if (!(error instanceof OpenerValueError)) throw error;
    return { status: "failed", reason: "invalid-value", message: error.message, sessionId, cwd };
  }

  try {
    await deps.execFile(command.file, command.args, { shell: false, windowsHide: true });
  } catch (error) {
    // Only the error code is reported: the raw message can carry the arguments and the path.
    const code = (error as { code?: unknown } | null)?.code;
    const detail = typeof code === "string" || typeof code === "number" ? ` (${code})` : "";
    return {
      status: "failed",
      reason: "spawn-failed",
      message: `The session opener could not be started${detail}`,
      sessionId,
      cwd,
    };
  }
  return { status: "opened", sessionId, cwd };
}
