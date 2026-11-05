// `pnpm bootstrap`: the entry that fills in the real io for bootstrap.ts (M7.10).

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bootstrap } from "./bootstrap.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

function pnpmVersion(): string | undefined {
  const r = spawnSync("pnpm", ["--version"], { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

async function ask(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(y|yes)$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

bootstrap(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  root,
  packageJson: JSON.parse(readFileSync(`${root}package.json`, "utf8")),
  nodeVersion: process.versions.node,
  pnpmVersion: pnpmVersion(),
  run: (command, args, cwd) =>
    new Promise((resolve) => {
      const child = spawn(command, args, { cwd, stdio: "inherit" });
      child.once("error", () => resolve(1));
      child.once("close", (code) => resolve(code ?? 1));
    }),
  confirm: process.stdin.isTTY ? ask : undefined,
}).then((code) => {
  process.exitCode = code;
});
