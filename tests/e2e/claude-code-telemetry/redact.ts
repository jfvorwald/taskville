// Turns a live run's raw recordings into committed replay fixtures (M2.10):
//
//   node tests/e2e/claude-code-telemetry/redact.ts --out <live --out dir>
//
// Rewrites the scratch directory to /tmp/taskville-e2e (and its Claude project slug to match),
// the home directory to /Users/dev, the per-user temp root to /tmp/claude-uid, the repository
// checkout to /repo, the user and host names to `dev` and `host`, and the seeded token to a
// placeholder the replay test fills back in. IDs (session_id, agent_id, tool_use_id, prompt_id)
// are the real random values. Refuses to write a fixture that still holds any of the originals.

import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { REPO } from "./harness.ts";

export const FIXTURES = join(import.meta.dirname, "fixtures");
export const REDACTED_ROOT = "/tmp/taskville-e2e";
export const REDACTED_PROJECT = `${REDACTED_ROOT}/proj`;
export const TOKEN_PLACEHOLDER = "@@FAKE_TOKEN@@";
/** The seeded token the live run used (`live.ts`), built so no token-shaped literal is committed. */
export const FAKE_TOKEN = `${["gh", "p_"].join("")}E2eFakeTok3nZq7Xw2Lr9Kd4Mn8Pv3Ts6Hb1J`;

/** Claude Code's project slug for a path: every character outside [A-Za-z0-9] becomes `-`. */
const slug = (path: string) => path.replace(/[^A-Za-z0-9]/g, "-");

export function redactor(outDir: string): (text: string) => string {
  const real = realpathSync(outDir);
  const user = userInfo().username;
  const home = homedir();
  const uid = userInfo().uid;
  const pairs: [string, string][] = [
    [slug(join(real, "proj")), slug(REDACTED_PROJECT)],
    [slug(join(outDir, "proj")), slug(REDACTED_PROJECT)],
    [real, REDACTED_ROOT],
    [outDir, REDACTED_ROOT],
    [REPO, "/repo"],
    [FAKE_TOKEN, TOKEN_PLACEHOLDER],
    [`/private/tmp/claude-${uid}`, "/tmp/claude-uid"],
    [`/tmp/claude-${uid}`, "/tmp/claude-uid"],
    [home, "/Users/dev"],
    [`-Users-${user}-`, "-Users-dev-"],
    [hostname(), "host"],
  ];
  pairs.sort((a, b) => b[0].length - a[0].length);
  return (text) => {
    let out = text;
    for (const [from, to] of pairs) out = out.split(from).join(to);
    return out;
  };
}

/** What must never be left in a fixture. */
export function leftovers(text: string, outDir: string): string[] {
  // A user or host name that is also (part of) a replacement value ("dev", "host") cannot be told
  // apart from it, so it is not a leftover.
  const replacements = ["/Users/dev", "dev", "host", REDACTED_ROOT, "/repo", "/tmp/claude-uid"];
  const needles = [
    userInfo().username,
    homedir(),
    hostname(),
    FAKE_TOKEN,
    outDir,
    REPO,
    ["gh", "p_"].join(""),
  ].filter((n) => !replacements.includes(n));
  return needles.filter((n) => n !== "" && text.includes(n));
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  if (values.out === undefined) throw new Error("--out <live run dir> is required");
  const raw = join(values.out, "raw");
  const redact = redactor(values.out);
  for (const name of readdirSync(raw).filter((n) => n.endsWith(".jsonl"))) {
    const text = redact(readFileSync(join(raw, name), "utf8"));
    const left = leftovers(text, values.out);
    if (left.length > 0) throw new Error(`${name} still holds ${left.length} unredacted value(s)`);
    writeFileSync(join(FIXTURES, name), text);
    console.log(`fixtures/${name}: ${text.split("\n").filter((l) => l !== "").length} hooks`);
  }
}
