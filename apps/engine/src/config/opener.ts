/**
 * The session opener is a user-configured program run by the command service
 * (M4) with `execFile` and an argument array, never through a shell. It is set
 * only in the config file or through the CLI, never from the browser.
 *
 * Template: `[program, ...args]`. Arguments may contain the placeholders below,
 * replaced literally in one pass, so a value can never add, split, or re-expand
 * arguments. The program itself may not contain a placeholder, and may not be a
 * shell or an interpreter that would evaluate an argument as code.
 */
export const OPENER_PLACEHOLDERS = ["sessionId", "cwd"] as const;
export type OpenerValues = Record<(typeof OPENER_PLACEHOLDERS)[number], string>;

const MAX_ARGS = 32;
const MAX_ARG_LENGTH = 1024;
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const KNOWN = new Set<string>(OPENER_PLACEHOLDERS);
const KNOWN_LIST = OPENER_PLACEHOLDERS.map((p) => `{${p}}`).join(", ");

const SHELLS = new Set([
  "sh",
  "ash",
  "bash",
  "dash",
  "zsh",
  "ksh",
  "mksh",
  "csh",
  "tcsh",
  "fish",
  "busybox",
  "env",
  "xargs",
  "sudo",
  "doas",
  "nohup",
  "cmd",
  "powershell",
  "pwsh",
  "wsl",
  "osascript",
]);
const INTERPRETER = /^(node|deno|bun|python|perl|ruby|php|lua|tclsh|wish)[0-9.]*$/;

export interface OpenerIssue {
  /** Index of the offending element, or undefined for the template as a whole. */
  index?: number;
  message: string;
}

/** Validation problems with an opener template; an empty list means it is valid. */
export function openerIssues(template: unknown): OpenerIssue[] {
  if (typeof template === "string") {
    return [
      {
        message:
          'must be an array like ["open", "-a", "Terminal", "{cwd}"]; shell command strings are not supported',
      },
    ];
  }
  if (!Array.isArray(template) || template.length === 0) {
    return [{ message: 'must be a non-empty array like ["open", "{cwd}"]' }];
  }
  if (template.length > MAX_ARGS) return [{ message: `must have at most ${MAX_ARGS} elements` }];
  const issues: OpenerIssue[] = [];
  template.forEach((arg: unknown, index) => {
    if (typeof arg !== "string" || arg.length === 0 || arg.length > MAX_ARG_LENGTH) {
      issues.push({
        index,
        message: `must be a non-empty string of at most ${MAX_ARG_LENGTH} characters`,
      });
      return;
    }
    if (arg.includes("\u0000")) {
      issues.push({ index, message: "must not contain a NUL character" });
      return;
    }
    const placeholders = [...arg.matchAll(PLACEHOLDER)].map((m) => m[1] ?? "");
    if (index === 0) {
      if (placeholders.length > 0) {
        issues.push({
          index,
          message: "the program must be fixed; a placeholder cannot choose it",
        });
      } else if (isShell(arg)) {
        issues.push({
          index,
          message: `"${arg}" is a shell or interpreter; name the opener program itself (for example "open" or "code")`,
        });
      }
      return;
    }
    for (const name of placeholders) {
      if (!KNOWN.has(name)) {
        issues.push({ index, message: `unknown placeholder {${name}}; use ${KNOWN_LIST}` });
      }
    }
  });
  return issues;
}

/** Fills a validated template. Returns the `execFile` program and argument array. */
export function renderOpener(
  template: readonly string[],
  values: OpenerValues,
): { file: string; args: string[] } {
  const [file = "", ...rest] = template;
  const args = rest.map((arg) =>
    arg.replace(PLACEHOLDER, (match, name: string) =>
      KNOWN.has(name) ? values[name as keyof OpenerValues] : match,
    ),
  );
  return { file, args };
}

function isShell(program: string): boolean {
  const base = (program.split(/[\\/]/).pop() ?? program).toLowerCase().replace(/\.exe$/, "");
  return SHELLS.has(base) || INTERPRETER.test(base);
}
