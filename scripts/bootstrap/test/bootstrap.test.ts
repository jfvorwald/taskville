import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrap } from "../src/bootstrap.ts";

// M7.10 (#382): `pnpm bootstrap`. Red-phase tests.
//
// The logic is a pure module, scripts/bootstrap/src/bootstrap.ts, exporting
//   bootstrap(argv: string[], io: BootstrapIo): Promise<number>     (the exit code)
// with scripts/bootstrap/src/main.ts as the thin entry (`node scripts/bootstrap/src/main.ts`,
// wired as the root package.json "bootstrap" script) that fills in the real io. argv: [--yes].
// Seams, all on BootstrapIo, so nothing here runs pnpm, touches the network or reads the real
// package.json:
//   stdout(text), stderr(text)
//   root: string                      the repository root, only used as a cwd for the runner
//   packageJson: { engines: { node: string }, packageManager: string }
//                                     (main.ts reads the repo's package.json)
//   nodeVersion: string               e.g. "26.8.2"
//   pnpmVersion: string | undefined   e.g. "12.4.2"; undefined means pnpm was not found
//   run(command: string, args: string[], cwd: string): Promise<number>
//                                     runs a program with an argv array, resolves its exit code
//   confirm?: (question: string) => Promise<boolean>   absent when not on a terminal
// Contract: versions are checked first; a wrong one prints a plain fix sentence (stderr or stdout)
// naming the wanted version, runs nothing, exits 1. Then, in order: `pnpm install` at root,
// `pnpm --filter @taskville/web build` at root, then the global link offer
// (`pnpm link --global` in <root>/apps/cli), which is asked first; --yes skips the question and
// links; no confirm and no --yes means not linked. A failing step stops with exit 1 and a sentence
// naming the step. The LAST non-empty line printed is the next step: `taskville start` when the
// link was made, otherwise `pnpm taskville start`. Declining the link is exit 0.

const ROOT = "/repo";
const pkg = { engines: { node: ">=26.8.2 <27" }, packageManager: "pnpm@12.4.2" };

// Quiet-mode seam (real-use fix): run takes an optional 4th argument
//   options?: { quiet?: boolean | undefined; output?: (chunk: string) => void }
// With quiet: true the runner must not show the program's output; it passes every chunk of
// stdout and stderr to options.output instead. bootstrap runs the web build quiet, prints
// "Building the web client..." instead of the output, and on failure prints only the last ~30
// lines of what it captured. `pnpm install` and `pnpm link` may stay visible (not quiet).
type RunOptions = { quiet?: boolean | undefined; output?: (chunk: string) => void };

function setup(
  over: Record<string, unknown> = {},
  codes: Record<string, number> = {},
  emit: Record<string, string> = {},
) {
  const calls: { command: string; args: string[]; cwd: string; quiet?: boolean }[] = [];
  const questions: string[] = [];
  let out = "";
  let err = "";
  const io = {
    stdout: (t: string) => {
      out += t;
    },
    stderr: (t: string) => {
      err += t;
    },
    root: ROOT,
    packageJson: pkg,
    nodeVersion: "26.8.2",
    pnpmVersion: "12.4.2" as string | undefined,
    run: async (command: string, args: string[], cwd: string, options?: RunOptions) => {
      calls.push({ command, args, cwd, quiet: options?.quiet });
      const text = emit[`${command} ${args.join(" ")}`];
      if (text !== undefined) options?.output?.(text);
      return codes[`${command} ${args.join(" ")}`] ?? 0;
    },
    confirm: async (q: string) => {
      questions.push(q);
      return true;
    },
    ...over,
  };
  return {
    io,
    calls,
    questions,
    text: () => out + err,
    last: () => (out + err).trim().split("\n").at(-1) ?? "",
  };
}

const cmds = (calls: { command: string; args: string[] }[]) =>
  calls.map((c) => `${c.command} ${c.args.join(" ")}`);

describe("bootstrap versions", () => {
  it.each(["25.9.0", "26.8.1", "27.0.0"])(
    "Node %s: prints a fix sentence, runs nothing, exits 1",
    async (v) => {
      const s = setup({ nodeVersion: v });
      expect(await bootstrap(["--yes"], s.io)).toBe(1);
      expect(s.text()).toMatch(/Node/);
      expect(s.text()).toContain("26.8.2");
      expect(s.calls).toEqual([]);
    },
  );

  it("pnpm of another major: names the wanted version, runs nothing, exits 1", async () => {
    const s = setup({ pnpmVersion: "11.9.0" });
    expect(await bootstrap(["--yes"], s.io)).toBe(1);
    expect(s.text()).toMatch(/pnpm/);
    expect(s.text()).toContain("12.4.2");
    expect(s.calls).toEqual([]);
  });

  it("pnpm missing: says to install it, exits 1", async () => {
    const s = setup({ pnpmVersion: undefined });
    expect(await bootstrap(["--yes"], s.io)).toBe(1);
    expect(s.text()).toMatch(/pnpm/i);
    expect(s.text()).toMatch(/install/i);
    expect(s.calls).toEqual([]);
  });

  it("accepts a newer minor of the same pnpm major and a newer Node in range", async () => {
    const s = setup({ pnpmVersion: "12.9.1", nodeVersion: "26.12.0" });
    expect(await bootstrap(["--yes"], s.io)).toBe(0);
  });
});

describe("bootstrap steps", () => {
  it("installs, builds the web client, links with --yes, and ends on `taskville start`", async () => {
    const s = setup();
    expect(await bootstrap(["--yes"], s.io)).toBe(0);
    expect(cmds(s.calls)).toEqual([
      "pnpm install",
      "pnpm --filter @taskville/web build",
      "pnpm link --global",
    ]);
    expect(s.calls.map((c) => c.cwd)).toEqual([ROOT, ROOT, join(ROOT, "apps/cli")]);
    expect(s.questions).toEqual([]);
    expect(s.last()).toMatch(/taskville start/);
    expect(s.last()).not.toMatch(/pnpm taskville start/);
  });

  it("asks before linking and links on yes", async () => {
    const s = setup();
    expect(await bootstrap([], s.io)).toBe(0);
    expect(s.questions).toHaveLength(1);
    expect(s.questions[0]).toMatch(/taskville/);
    expect(cmds(s.calls)).toContain("pnpm link --global");
    expect(s.last()).toMatch(/taskville start/);
  });

  it("declining the link is fine: no link call, exit 0, next step runs through pnpm", async () => {
    const s = setup({ confirm: async () => false });
    expect(await bootstrap([], s.io)).toBe(0);
    expect(cmds(s.calls)).toEqual(["pnpm install", "pnpm --filter @taskville/web build"]);
    expect(s.last()).toMatch(/pnpm taskville start/);
  });

  it("without a terminal and without --yes it does not link", async () => {
    const s = setup({ confirm: undefined });
    expect(await bootstrap([], s.io)).toBe(0);
    expect(cmds(s.calls)).not.toContain("pnpm link --global");
    expect(s.last()).toMatch(/pnpm taskville start/);
  });

  it("stops at a failing install, naming the step, without building", async () => {
    const s = setup({}, { "pnpm install": 1 });
    expect(await bootstrap(["--yes"], s.io)).toBe(1);
    expect(s.text()).toMatch(/install/i);
    expect(cmds(s.calls)).toEqual(["pnpm install"]);
  });

  it("stops at a failing web build, naming the step, without linking", async () => {
    const s = setup({}, { "pnpm --filter @taskville/web build": 2 });
    expect(await bootstrap(["--yes"], s.io)).toBe(1);
    expect(s.text()).toMatch(/web/i);
    expect(cmds(s.calls)).not.toContain("pnpm link --global");
  });
});

describe("bootstrap wiring", () => {
  it("the root package.json has a bootstrap script that runs scripts/bootstrap with node", () => {
    const root = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "..", "..", "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(root.scripts.bootstrap).toMatch(/^node scripts\/bootstrap\/src\/main\.ts/);
  });
});

describe("bootstrap quiet build", () => {
  const BUILD = "pnpm --filter @taskville/web build";
  const noise = Array.from({ length: 300 }, (_, i) => `vite line ${i + 1}`).join("\n");

  it("runs the web build quiet and shows a one-line progress message, not its output", async () => {
    const s = setup({}, {}, { [BUILD]: noise });
    expect(await bootstrap(["--yes"], s.io)).toBe(0);
    const build = s.calls.find((c) => `${c.command} ${c.args.join(" ")}` === BUILD);
    expect(build?.quiet).toBe(true);
    expect(s.text()).toContain("Building the web client...");
    expect(s.text()).not.toContain("vite line");
  });

  it("on failure shows only the last ~30 captured lines and names the step", async () => {
    const s = setup({}, { [BUILD]: 2 }, { [BUILD]: noise });
    expect(await bootstrap(["--yes"], s.io)).toBe(1);
    expect(s.text()).toContain("vite line 300");
    expect(s.text()).toContain("vite line 280");
    expect(s.text()).not.toContain("vite line 200\n");
    expect(s.text()).not.toMatch(/vite line 1\n/);
    expect(s.text().split("\n").length).toBeLessThan(60);
    expect(s.text()).toMatch(/web/i);
  });
});
