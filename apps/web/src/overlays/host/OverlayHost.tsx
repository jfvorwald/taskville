import { Component, type ReactNode, useMemo, useSyncExternalStore } from "react";
import styles from "./host.module.css";
import { createOverlayProps, type OverlayHostContext } from "./props.ts";
import { type OverlayRegistry, resolveActiveOverlays } from "./registry.ts";
import type { OverlayDefinition, OverlaySlot } from "./types.ts";

export interface OverlayHostProps extends OverlayHostContext {
  registry: OverlayRegistry;
  /** Ids of overlays switched on. Which preset is active is the caller's business. */
  enabled: readonly string[];
  /** Which sidebar to show when several are enabled. */
  sidebar?: string | null;
}

/**
 * Renders the registered overlays into their slots. It owns stacking order, the single sidebar,
 * and pointer routing: the host and its slots are `pointer-events: none`, so only an overlay's
 * `InteractiveRegion` takes the pointer and the rest reaches the city underneath.
 */
export function OverlayHost(props: OverlayHostProps) {
  const { registry, enabled, sidebar, mode, selectors, selection, anchors, runIntent, storage } =
    props;
  const definitions = useSyncExternalStore(registry.subscribe, registry.list, registry.list);
  const active = useMemo(
    () => resolveActiveOverlays(definitions, { mode, enabled, sidebar }),
    [definitions, mode, enabled, sidebar],
  );
  const context = useMemo<OverlayHostContext>(
    () => ({ mode, selectors, selection, anchors, runIntent, storage }),
    [mode, selectors, selection, anchors, runIntent, storage],
  );

  const slot = (name: OverlaySlot, className: string) => (
    <div className={className} data-slot={name}>
      {active[name].map((definition) => (
        <OverlayBoundary key={definition.id} id={definition.id}>
          <Mounted definition={definition} context={context} />
        </OverlayBoundary>
      ))}
    </div>
  );

  return (
    <div className={styles.host} data-testid="overlay-host" data-mode={mode}>
      {slot("world-labels", styles.worldLabels)}
      {slot("bubbles", styles.bubbles)}
      {slot("timeline", styles.timeline)}
      {slot("sidebar", styles.sidebar)}
      {slot("header", styles.header)}
    </div>
  );
}

function Mounted({
  definition,
  context,
}: {
  definition: OverlayDefinition;
  context: OverlayHostContext;
}) {
  const props = useMemo(() => createOverlayProps(definition.id, context), [definition.id, context]);
  const { Component: Overlay } = definition;
  return <Overlay {...props} />;
}

/** One overlay failing must not take the city and its neighbours down with it. */
class OverlayBoundary extends Component<{ id: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    console.error(`overlay "${this.props.id}" crashed`, error);
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}
