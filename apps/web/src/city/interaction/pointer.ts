/** Whether the end of a press selects what is under the pointer: only a pointerup that did not drag. */
export function shouldSelectOnRelease(input: { type: string; moved: boolean }): boolean {
  return input.type === "pointerup" && !input.moved;
}
