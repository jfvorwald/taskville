import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { type AnchoredBox, layoutAnchored, type PlacedBox } from "./collision.ts";
import styles from "./host.module.css";
import type { AnchorSource } from "./types.ts";

interface Registration {
  anchorId: string;
  priority: number;
  width: number;
  height: number;
}

interface LayerApi {
  register(id: string, registration: Registration): void;
  unregister(id: string): void;
  placements: ReadonlyMap<string, PlacedBox>;
}

const LayerContext = createContext<LayerApi | null>(null);

export interface AnchorLayerProps {
  source: AnchorSource;
  /** Space kept between colliding labels, px. Default 4. */
  gap?: number;
  /** How far off screen an anchor may be and still show its label, px. Default 48. */
  margin?: number;
  children: ReactNode;
}

/**
 * A DOM layer for things that hang off world anchors (agent labels, speech bubbles). Children
 * are `Anchored`; the layer projects each anchor through the camera, resolves collisions, and
 * positions them. Used by the world-labels and bubbles overlays.
 */
export function AnchorLayer({ source, gap = 4, margin = 48, children }: AnchorLayerProps) {
  const version = useSyncExternalStore(source.subscribe, source.getVersion, source.getVersion);
  const registrations = useRef(new Map<string, Registration>());
  const [registrationVersion, setRegistrationVersion] = useState(0);

  const register = useCallback((id: string, next: Registration) => {
    const current = registrations.current.get(id);
    if (
      current &&
      current.anchorId === next.anchorId &&
      current.priority === next.priority &&
      current.width === next.width &&
      current.height === next.height
    ) {
      return;
    }
    registrations.current.set(id, next);
    setRegistrationVersion((v) => v + 1);
  }, []);

  const unregister = useCallback((id: string) => {
    if (registrations.current.delete(id)) setRegistrationVersion((v) => v + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version and registrationVersion are the change signals for source and the ref
  const placements = useMemo(() => {
    const viewport = source.getViewport();
    if (!viewport) return new Map<string, PlacedBox>();
    const boxes: AnchoredBox[] = [];
    for (const [id, r] of registrations.current) {
      const point = source.project(r.anchorId, { margin });
      boxes.push({
        id,
        x: point?.x ?? 0,
        y: point?.y ?? 0,
        width: r.width,
        height: r.height,
        priority: r.priority,
        visible: point?.visible === true && r.width > 0 && r.height > 0,
      });
    }
    return new Map(layoutAnchored(boxes, viewport, { gap }).map((p) => [p.id, p]));
  }, [source, version, registrationVersion, gap, margin]);

  const api = useMemo<LayerApi>(
    () => ({ register, unregister, placements }),
    [register, unregister, placements],
  );

  return (
    <div className={styles.anchorLayer} data-anchor-layer="">
      <LayerContext.Provider value={api}>{children}</LayerContext.Provider>
    </div>
  );
}

export interface AnchoredProps {
  /** Unique within the layer. */
  id: string;
  /** The world anchor to follow. */
  anchorId: string;
  /** Higher wins a contested spot. Default 0. */
  priority?: number;
  /** Let the pointer reach the content (a clickable label). Default false: clicks pass through. */
  interactive?: boolean;
  children: ReactNode;
}

/** Content pinned above a world anchor. Must be rendered inside an `AnchorLayer`. */
export function Anchored({
  id,
  anchorId,
  priority = 0,
  interactive = false,
  children,
}: AnchoredProps) {
  const layer = useContext(LayerContext);
  if (!layer) throw new Error("Anchored must be rendered inside an AnchorLayer");
  const { register, unregister, placements } = layer;
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () =>
      register(id, {
        anchorId,
        priority,
        width: element.offsetWidth,
        height: element.offsetHeight,
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      unregister(id);
    };
  }, [id, anchorId, priority, register, unregister]);

  const placed = placements.get(id);
  const shown = placed?.visible === true;
  return (
    <div
      ref={ref}
      className={interactive ? `${styles.anchored} ${styles.interactive}` : styles.anchored}
      style={{
        transform: placed
          ? `translate3d(${Math.round(placed.left)}px, ${Math.round(placed.top)}px, 0)`
          : undefined,
        visibility: shown ? "visible" : "hidden",
      }}
      aria-hidden={shown ? undefined : true}
    >
      {children}
    </div>
  );
}
