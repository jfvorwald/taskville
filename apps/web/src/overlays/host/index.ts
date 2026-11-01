/**
 * The overlay host's public surface. Later tickets import from here:
 *
 * - register an overlay: add its definition to the list in `overlays/index.tsx`
 * - publish world anchors from the city: `worldAnchors.setAnchor("agent:<id>", [x, y, z])`
 * - hang DOM off anchors in a world-labels or bubbles overlay: `<AnchorLayer source={props.anchors}>`
 *   with `<Anchored id anchorId priority>` children
 */
import { createAnchorSource } from "./anchors.ts";

/** The app-wide anchor store. The camera bridge writes the projection; the city writes anchors. */
export const worldAnchors = createAnchorSource();

export { AnchorBridge } from "./AnchorBridge.tsx";
export { Anchored, AnchorLayer } from "./AnchorLayer.tsx";
export { createAnchorSource } from "./anchors.ts";
export { InteractiveRegion } from "./InteractiveRegion.tsx";
export { OverlayHost, type OverlayHostProps } from "./OverlayHost.tsx";
export { createOverlayRegistry, type OverlayRegistry, resolveActiveOverlays } from "./registry.ts";
export * from "./types.ts";
