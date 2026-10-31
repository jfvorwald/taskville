/** Who sent a request: the CLI and telemetry shim token, the permission bridge token, or a paired browser. */
export type CredentialKind = "cli" | "bridge" | "session";

/** What a route needs. */
export type Scope = "read" | "ingest" | "bridge" | "command" | "unpair";

/**
 * The full grant table. Commands are reachable only from a paired browser
 * session (ARCHITECTURE.md 9.2): the supervised agent runs as the same OS
 * user and can read the token files, so a token must never approve anything.
 */
const GRANTS: Record<CredentialKind, readonly Scope[]> = {
  cli: ["read", "ingest", "unpair"],
  bridge: ["bridge"],
  session: ["read", "command"],
};

export function allows(kind: CredentialKind, scope: Scope): boolean {
  return GRANTS[kind].includes(scope);
}
