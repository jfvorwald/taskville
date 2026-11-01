import { useFrame } from "@react-three/fiber";
import { type RefObject, useEffect, useRef } from "react";
import type { Group } from "three";
import type { AgentView } from "../agents/types.ts";
import { attentionEmote } from "./emote.ts";
import { type AttentionMarks, createAttentionMarks } from "./marks.ts";
import { attentionPulse, type PulseInput, type PulseState } from "./pulse.ts";

/**
 * Draws one agent's stuck visuals each frame: the red or amber ring and rim glow pulsing with the
 * time since the attention record began, and the emote over the head. `now` is the clock the
 * attention selector used (the data store's default is `Date.now`). Nothing is allocated per frame.
 */
export function useAttentionMarks(
  root: RefObject<Group | null>,
  view: RefObject<AgentView>,
  reducedMotion: boolean,
  now: () => number = Date.now,
): void {
  const marks = useRef<AttentionMarks | null>(null);
  const state = useRef<PulseState>({ intensity: 0, ring: false, hue: null, frequencyHz: 0 });
  const input = useRef<PulseInput>({ elapsedMs: 0, reducedMotion });

  useEffect(
    () => () => {
      marks.current?.dispose();
      marks.current = null;
    },
    [],
  );

  useFrame(() => {
    const g = root.current;
    if (g === null) return;
    const a = view.current.attention;
    if (a === undefined) {
      // Nothing needs showing, and no marks were ever made for an agent that never needed them.
      marks.current?.update(attentionPulse("waiting", input.current, state.current), null);
      return;
    }
    input.current.elapsedMs = a.sinceMs === undefined ? 0 : now() - a.sinceMs;
    input.current.reducedMotion = reducedMotion;
    const pulse = attentionPulse(a.level, input.current, state.current);
    const emote = attentionEmote({ level: a.level, kind: a.kind ?? "" });
    if (marks.current === null) {
      if (!pulse.ring && emote === null) return;
      marks.current = createAttentionMarks(g);
    }
    marks.current.update(pulse, emote);
  });
}
