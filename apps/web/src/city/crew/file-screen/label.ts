import { visibleControls } from "../../../overlays/action-card/format.ts";

const NO_FILE = "no file";
const MAX = 32;

/**
 * The text for the floating screen above the selected agent's workstation: the base name of the
 * current file as plain text, hidden characters made visible, and no longer than 32 characters
 * (the end of a long name is kept for its extension).
 */
export function fileScreenLabel(path: string | null | undefined): string {
  const base = (path ?? "").split(/[\\/]/).pop() ?? "";
  if (base === "") return NO_FILE;
  const shown = Array.from(visibleControls(base));
  if (shown.length <= MAX) return shown.join("");
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(base)?.[0] ?? "";
  return `${shown.slice(0, MAX - 1 - ext.length).join("")}…${ext}`;
}
