const OWN_ESCAPE_SELECTOR = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
const TEXT_ENTRY = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Whether an Escape keydown should clear the city selection: not when something else already
 * handled it, and not when it belongs to a text field, a contenteditable element or a dialog.
 */
export function shouldClearOnEscape(event: KeyboardEvent): boolean {
  if (event.key !== "Escape" || event.defaultPrevented) return false;
  const target = event.target as Partial<HTMLElement> | null;
  if (target === null || target === undefined) return true;
  if (typeof target.tagName === "string" && TEXT_ENTRY.has(target.tagName.toUpperCase())) {
    return false;
  }
  if (target.isContentEditable === true) return false;
  if (typeof target.closest === "function" && target.closest(OWN_ESCAPE_SELECTOR) !== null) {
    return false;
  }
  return true;
}
