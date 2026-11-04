import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BoxGeometry, type Group, type Object3D } from "three";
import { type DataStore, dataStore } from "../../../data/store.ts";
import { worldAnchors } from "../../../overlays/host/index.ts";
import type { AnchorSource } from "../../../overlays/host/types.ts";
import { colorMaterial } from "../../agents/resources.ts";
import { collectPickables, createPicker } from "../../interaction/pick.ts";
import { type SelectionStore, selectionStore } from "../../interaction/selection.ts";
import { agentAnchorId } from "../../movement/AgentLabels.tsx";
import {
  createEnvelopeLog,
  ENVELOPE_FLIGHT_MS,
  type Envelope,
  envelopeLabel,
} from "./envelopes.ts";
import { type FeedFocus, feedFocus as sharedFeedFocus } from "./feedFocus.ts";

// M5.04: a paper envelope flies from the sender to the recipient for each team.message event
// (ARCHITECTURE 2.9). Hover says who wrote to whom; a click selects the sender and asks the agent
// panel to open the message in its Live feed.

const PAPER = "#f1ead8";
const FLAP = "#d9534f";
const ARC_HEIGHT = 0.8;
const HOVER_HEIGHT = 1.4;
const LIFT = 1.2;
const CLICK_SLOP_PX = 5;
const TOOLTIP_OFFSET_PX = 14;

let geometries: { body: BoxGeometry; flap: BoxGeometry } | undefined;
function envelopeGeometries() {
  geometries ??= {
    body: new BoxGeometry(0.5, 0.1, 0.34),
    flap: new BoxGeometry(0.3, 0.12, 0.14),
  };
  return geometries;
}

export interface EnvelopeLayerProps {
  store?: DataStore;
  anchors?: AnchorSource;
  selection?: SelectionStore;
  feedFocus?: FeedFocus;
  reducedMotion?: boolean;
}

/**
 * Where an envelope is at `now`. Under reduced motion nothing glides: the envelope waits at the
 * sender for the first half of its time and then sits at the recipient. A recipient that is not a
 * known agent gets a hover above the sender instead.
 */
function place(
  envelope: Envelope,
  now: number,
  anchors: AnchorSource,
  reducedMotion: boolean,
  out: [number, number, number],
): boolean {
  const from = anchors.getAnchor(agentAnchorId(envelope.fromAgentId));
  if (from === undefined) return false;
  const to =
    envelope.toAgentId === null ? undefined : anchors.getAnchor(agentAnchorId(envelope.toAgentId));
  const t = Math.min(1, Math.max(0, (now - envelope.sentAt) / ENVELOPE_FLIGHT_MS));
  if (to === undefined) {
    out[0] = from[0];
    out[1] = from[1] + HOVER_HEIGHT;
    out[2] = from[2];
    return true;
  }
  const u = reducedMotion ? (t < 0.5 ? 0 : 1) : t;
  out[0] = from[0] + (to[0] - from[0]) * u;
  out[1] =
    from[1] +
    (to[1] - from[1]) * u +
    LIFT +
    (reducedMotion ? 0 : Math.sin(Math.PI * u) * ARC_HEIGHT);
  out[2] = from[2] + (to[2] - from[2]) * u;
  return true;
}

function EnvelopeMesh({ envelope }: { envelope: Envelope }) {
  const { body, flap } = envelopeGeometries();
  return (
    <>
      <mesh geometry={body} material={colorMaterial(PAPER)} />
      <mesh geometry={flap} material={colorMaterial(FLAP)} position={[0, 0.08, 0]} />
      <group visible={false} userData={{ for: envelope.id }} />
    </>
  );
}

export function EnvelopeLayer({
  store = dataStore,
  anchors = worldAnchors,
  selection = selectionStore,
  feedFocus = sharedFeedFocus,
  reducedMotion = false,
}: EnvelopeLayerProps) {
  const { gl, camera, scene } = useThree();
  const log = useMemo(() => createEnvelopeLog(), []);
  const [live, setLive] = useState<readonly Envelope[]>([]);
  const shownIds = useRef("");
  const layer = useRef<Group>(null);
  const roots = useRef(new Map<string, Group>());
  const hovered = useRef<string | null>(null);
  const tooltip = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(() => {
    const now = store.now();
    const next = log.live(now);
    const key = next.map((e) => e.id).join(",");
    if (key === shownIds.current) return;
    shownIds.current = key;
    setLive([...next]);
  }, [store, log]);

  useEffect(() => {
    return store.onEvent((event) => {
      const agents = store.getState().state?.agents ?? {};
      if (log.observe(event, agents, store.now()) === null) return;
      feedFocus.note(event.eventId, Date.parse(event.occurredAt));
      refresh();
    });
  }, [store, log, refresh, feedFocus]);

  useEffect(() => {
    const dom = gl.domElement;
    const picker = createPicker();
    const pickables: Object3D[] = [];
    let downX = 0;
    let downY = 0;
    let down = false;

    // The scene's shared picker, so a building in front of the envelope hides it.
    const hit = (e: PointerEvent): string | null => {
      const rect = dom.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      collectPickables(scene, pickables);
      camera.updateMatrixWorld();
      picker.pick(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
        camera,
        pickables,
      );
      const id = picker.control?.userData.envelopeId;
      return typeof id === "string" ? id : null;
    };
    const hideTooltip = () => {
      hovered.current = null;
      tooltip.current?.remove();
      tooltip.current = null;
    };
    const onMove = (e: PointerEvent) => {
      const id = hit(e);
      if (id === null) {
        hideTooltip();
        return;
      }
      const envelope = log.live(store.now()).find((x) => x.id === id);
      if (envelope === undefined) {
        hideTooltip();
        return;
      }
      if (tooltip.current === null) {
        const el = document.createElement("div");
        el.setAttribute("role", "tooltip");
        el.style.cssText =
          "position:fixed;z-index:1000;pointer-events:none;padding:4px 8px;border-radius:4px;background:#1f2a30;color:#f4f1e8;font:12px system-ui,sans-serif;max-width:280px";
        document.body.append(el);
        tooltip.current = el;
      }
      hovered.current = id;
      tooltip.current.textContent = envelopeLabel(envelope, store.getState().state?.agents ?? {});
      tooltip.current.style.left = `${e.clientX + TOOLTIP_OFFSET_PX}px`;
      tooltip.current.style.top = `${e.clientY + TOOLTIP_OFFSET_PX}px`;
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      down = true;
      downX = e.clientX;
      downY = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      if (!down) return;
      down = false;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > CLICK_SLOP_PX) return;
      const id = hit(e);
      if (id === null) return;
      const envelope = log.live(store.now()).find((x) => x.id === id);
      if (envelope === undefined) return;
      selection.select(envelope.fromAgentId);
      feedFocus.request(envelope.fromAgentId, envelope.id);
    };
    dom.addEventListener("pointermove", onMove);
    dom.addEventListener("pointerleave", hideTooltip);
    dom.addEventListener("pointerdown", onDown);
    dom.addEventListener("pointerup", onUp);
    return () => {
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerleave", hideTooltip);
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointerup", onUp);
      hideTooltip();
    };
  }, [gl, camera, scene, log, store, selection, feedFocus]);

  const position: [number, number, number] = useMemo(() => [0, 0, 0], []);
  useFrame(() => {
    const now = store.now();
    refresh();
    for (const envelope of log.live(now)) {
      const root = roots.current.get(envelope.id);
      if (root === undefined) continue;
      root.visible = place(envelope, now, anchors, reducedMotion, position);
      root.position.set(position[0], position[1], position[2]);
    }
    if (hovered.current !== null && !roots.current.has(hovered.current)) {
      tooltip.current?.remove();
      tooltip.current = null;
      hovered.current = null;
    }
  });

  return (
    <group ref={layer}>
      {live.map((envelope) => (
        <group
          key={envelope.id}
          ref={(g) => {
            if (g === null) roots.current.delete(envelope.id);
            else roots.current.set(envelope.id, g);
          }}
          userData={{ envelopeId: envelope.id, crewControl: true }}
        >
          <EnvelopeMesh envelope={envelope} />
        </group>
      ))}
    </group>
  );
}
