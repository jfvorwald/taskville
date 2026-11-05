import { join } from "node:path";

// `pnpm bootstrap` (M7.10, #382): check versions, install, build the web client, and offer a
// `taskville` command on PATH. Pure over `BootstrapIo`, so tests run it without pnpm or a network.

export interface BootstrapIo {
  stdout(text: string): void;
  stderr(text: string): void;
  /** The repository root; the working directory of the steps. */
  root: string;
  packageJson: { engines: { node: string }; packageManager: string };
  nodeVersion: string;
  /** Undefined when pnpm was not found. */
  pnpmVersion: string | undefined;
  /** Runs a program with an argv array and resolves its exit code. */
  run(
    command: string,
    args: string[],
    cwd: string,
    options?: { quiet?: boolean; output?: (chunk: string) => void },
  ): Promise<number>;
  /** Absent when not on a terminal. */
  confirm?: ((question: string) => Promise<boolean>) | undefined;
}

const parts = (version: string): number[] => version.split(".").map((n) => Number.parseInt(n, 10));

function nodeProblem(io: BootstrapIo): string | undefined {
  const range = io.packageJson.engines.node;
  const min = />=\s*(\d+(?:\.\d+){0,2})/.exec(range)?.[1] ?? "0";
  const max = /<\s*(\d+(?:\.\d+){0,2})/.exec(range)?.[1] ?? "9999";
  const v = parts(io.nodeVersion);
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < 3; i += 1) {
      const d = (a[i] ?? 0) - (b[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  if (cmp(v, parts(min)) >= 0 && cmp(v, parts(max)) < 0) return undefined;
  return `Node ${io.nodeVersion} will not work: Taskville needs Node ${min} or newer in the ${parts(min)[0]} line (${range}). Install it (for example with nvm: nvm install ${min}) and run pnpm bootstrap again.`;
}

function pnpmProblem(io: BootstrapIo): string | undefined {
  const wanted = io.packageJson.packageManager.replace(/^pnpm@/, "");
  const major = parts(wanted)[0];
  if (io.pnpmVersion === undefined) {
    return `pnpm was not found. Install pnpm ${wanted} (for example: corepack enable, or npm install -g pnpm@${wanted}) and run pnpm bootstrap again.`;
  }
  if (parts(io.pnpmVersion)[0] !== major) {
    return `pnpm ${io.pnpmVersion} is the wrong major version: this repository wants pnpm ${wanted}. Install it (for example: corepack enable, or npm install -g pnpm@${wanted}) and run pnpm bootstrap again.`;
  }
  return undefined;
}

export async function bootstrap(argv: string[], io: BootstrapIo): Promise<number> {
  const problem = nodeProblem(io) ?? pnpmProblem(io);
  if (problem !== undefined) {
    io.stderr(`${problem}\n`);
    return 1;
  }

  const steps: { name: string; args: string[]; cwd: string; quiet?: boolean }[] = [
    { name: "pnpm install", args: ["install"], cwd: io.root },
    {
      name: "the web client build",
      args: ["--filter", "@taskville/web", "build"],
      cwd: io.root,
      quiet: true,
    },
  ];
  for (const step of steps) {
    io.stdout(step.quiet === true ? "Building the web client...\n" : `Running ${step.name}...\n`);
    let captured = "";
    const code = await io.run(
      "pnpm",
      step.args,
      step.cwd,
      step.quiet === true ? { quiet: true, output: (chunk) => (captured += chunk) } : undefined,
    );
    if (code !== 0) {
      if (step.quiet === true) {
        const tail = captured
          .split("\n")
          .filter((l) => l !== "")
          .slice(-30);
        io.stderr(`${tail.join("\n")}\n`);
      }
      io.stderr(
        `${step.name} failed (exit ${code}); fix the error above and run pnpm bootstrap again.\n`,
      );
      return 1;
    }
  }

  let linked = false;
  const yes = argv.includes("--yes");
  const link =
    yes ||
    (io.confirm !== undefined &&
      (await io.confirm("Put a `taskville` command on your PATH (pnpm link --global)?")));
  if (link) {
    const code = await io.run("pnpm", ["link", "--global"], join(io.root, "apps/cli"));
    if (code === 0) linked = true;
    else io.stderr("pnpm link --global failed; carrying on without a taskville command.\n");
  }

  io.stdout("Done. Next step:\n");
  io.stdout(linked ? "taskville start\n" : "pnpm taskville start\n");
  return 0;
}
