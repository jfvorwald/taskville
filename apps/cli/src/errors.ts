// Exit codes (contracts/cli.md). 1 also covers usage errors, which the contract leaves open.
export const EXIT = {
  ok: 0,
  failure: 1,
  /** Unknown project, or a project ID that already exists. */
  notFound: 2,
  unreachable: 3,
  /** `events ingest`: some events were rejected or conflicted. */
  rejected: 4,
  /** 401 or 403: missing or invalid token, bad Host. */
  auth: 5,
} as const;

export class CliError extends Error {
  override name = "CliError";
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}
