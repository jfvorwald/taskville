import {
  EXCLUSIVE_SLOTS,
  type OverlayDefinition,
  type OverlayMode,
  type OverlaySlot,
  SLOTS,
} from "./types.ts";

export interface OverlayRegistry {
  /** Adds an overlay and returns a function that removes it again. Throws on a bad definition. */
  register(definition: OverlayDefinition): () => void;
  unregister(id: string): void;
  get(id: string): OverlayDefinition | undefined;
  /** Registration order. The same array until the registry changes. */
  list(): readonly OverlayDefinition[];
  subscribe(listener: () => void): () => void;
}

export function createOverlayRegistry(initial: readonly OverlayDefinition[] = []): OverlayRegistry {
  let items: readonly OverlayDefinition[] = [];
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };

  function unregister(id: string): void {
    if (!items.some((d) => d.id === id)) return;
    items = items.filter((d) => d.id !== id);
    emit();
  }

  function register(definition: OverlayDefinition): () => void {
    if (!(SLOTS as readonly string[]).includes(definition.slot)) {
      throw new Error(`overlay "${definition.id}": unknown slot "${definition.slot}"`);
    }
    if (definition.modes.length === 0) {
      throw new Error(`overlay "${definition.id}": needs at least one mode`);
    }
    if (items.some((d) => d.id === definition.id)) {
      throw new Error(`overlay "${definition.id}" is already registered`);
    }
    items = [...items, definition];
    emit();
    return () => {
      // Remove this exact definition, not a later one that reused the id.
      if (!items.includes(definition)) return;
      items = items.filter((d) => d !== definition);
      emit();
    };
  }

  for (const definition of initial) register(definition);

  return {
    register,
    unregister,
    get: (id) => items.find((d) => d.id === id),
    list: () => items,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export interface ActiveOverlayState {
  mode: OverlayMode;
  /** Ids of overlays switched on (by preset or by the user). */
  enabled: readonly string[];
  /** The sidebar to show when several are enabled. Defaults to the first one. */
  sidebar?: string | null | undefined;
}

/**
 * Which overlays render, per slot: enabled, registered, and supporting the current mode, in
 * registration order. An exclusive slot (the sidebar) keeps one: the chosen one if it qualifies,
 * otherwise the first that does.
 */
export function resolveActiveOverlays(
  definitions: readonly OverlayDefinition[],
  state: ActiveOverlayState,
): Record<OverlaySlot, OverlayDefinition[]> {
  const enabled = new Set(state.enabled);
  const result = Object.fromEntries(
    SLOTS.map((slot) => [slot, [] as OverlayDefinition[]]),
  ) as Record<OverlaySlot, OverlayDefinition[]>;
  for (const definition of definitions) {
    if (enabled.has(definition.id) && definition.modes.includes(state.mode)) {
      result[definition.slot].push(definition);
    }
  }
  for (const slot of EXCLUSIVE_SLOTS) {
    const candidates = result[slot];
    const chosen = candidates.find((d) => d.id === state.sidebar) ?? candidates[0];
    result[slot] = chosen ? [chosen] : [];
  }
  return result;
}
