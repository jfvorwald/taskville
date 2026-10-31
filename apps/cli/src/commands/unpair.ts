import type { PairingRevokeResponse } from "@taskville/protocol";
import type { Io } from "../context.ts";
import { parseCommand, printJson } from "../context.ts";
import { EXIT } from "../errors.ts";

export async function unpair(io: Io, args: string[]): Promise<number> {
  const { context } = parseCommand(io, args, {}, "taskville unpair");
  const body = await context.client().json<PairingRevokeResponse>("POST", "/v1/pairing/revoke");
  if (context.json) printJson(io, body);
  else io.stdout(`Revoked ${body.revoked} browser session${body.revoked === 1 ? "" : "s"}\n`);
  return EXIT.ok;
}
