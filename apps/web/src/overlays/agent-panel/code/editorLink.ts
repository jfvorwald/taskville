/** The editor the links open when nothing else is configured. */
export const DEFAULT_EDITOR_TEMPLATE = "vscode://file{path}";

/** URL schemes an editor link may use. Anything else (javascript:, data:, https:...) is refused. */
const EDITOR_SCHEMES: ReadonlySet<string> = new Set([
  "vscode",
  "vscode-insiders",
  "vscodium",
  "cursor",
  "windsurf",
  "zed",
  "idea",
  "subl",
  "txmt",
]);

const PLACEHOLDER = "{path}";
/** A template is plain printable ASCII: no whitespace, control, or non-ASCII characters. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const SCHEME = /^([a-z][a-z0-9+.-]*):/;

export interface EditorLinkOptions {
  template?: string;
  line?: number;
}

/**
 * An editor URL for an absolute file path, or null when it cannot be built safely. The URL comes
 * only from the fixed template with the path encoded segment by segment ("/" kept); the engine
 * and this module never open it. Null for a relative path, a "." or ".." segment, a NUL, a template
 * without exactly one {path}, or a scheme outside the editor allowlist.
 */
export function buildEditorLink(path: string, opts: EditorLinkOptions = {}): string | null {
  const template = opts.template ?? DEFAULT_EDITOR_TEMPLATE;
  if (!PRINTABLE_ASCII.test(template)) return null;
  const scheme = SCHEME.exec(template)?.[1];
  if (scheme === undefined || !EDITOR_SCHEMES.has(scheme)) return null;
  if (template.split(PLACEHOLDER).length !== 2) return null;
  if (!path.startsWith("/") || path.includes("\u0000")) return null;
  const segments = path.split("/");
  if (segments.some((segment) => segment === ".." || segment === ".")) return null;
  let encoded: string;
  try {
    encoded = segments.map(encodeURIComponent).join("/");
  } catch {
    // A lone surrogate cannot be encoded.
    return null;
  }
  const line = opts.line;
  const suffix = typeof line === "number" && Number.isInteger(line) && line > 0 ? `:${line}` : "";
  return template.replace(PLACEHOLDER, () => `${encoded}${suffix}`);
}
