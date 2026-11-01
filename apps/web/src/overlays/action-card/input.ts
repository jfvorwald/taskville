/**
 * The text the card shows for a held request's `toolInput`. It is the exact input and never cut:
 * a string as it is, a Bash-style `{ command }` as the command itself, anything else as
 * two-space pretty JSON so no key the agent sent is hidden.
 */
export function inputText(toolInput: unknown): string {
  if (typeof toolInput === "string") return toolInput;
  if (typeof toolInput === "object" && toolInput !== null && !Array.isArray(toolInput)) {
    const keys = Object.keys(toolInput);
    const command = (toolInput as { command?: unknown }).command;
    if (keys.length === 1 && keys[0] === "command" && typeof command === "string") return command;
  }
  return JSON.stringify(toolInput, null, 2) ?? "null";
}
