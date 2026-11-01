import type { StoredEnvelope } from "../data/domain.ts";
import type { AttentionFeed } from "../overlays/header/attention.ts";
import type { ChimingSoundscape } from "./soundscape.ts";

/**
 * What the soundscape listens to: the global attention feed (ARCHITECTURE 2.8), the selected
 * project's live events, and the theme state.
 */
export interface SoundscapeSources {
  attention: {
    getState(): { feed: AttentionFeed; ready: boolean };
    subscribe(listener: (state: { feed: AttentionFeed; ready: boolean }) => void): () => void;
  };
  data: {
    onEvent(listener: (event: StoredEnvelope) => void): () => void;
  };
  theme: {
    getState(): { themeId: string; history: boolean };
    subscribe(
      listener: (
        state: { themeId: string; history: boolean },
        prev: { themeId: string; history: boolean },
      ) => void,
    ): () => void;
  };
}

/** The agents in needs-you per project, as a nested map so no key is a joined string. */
type NeedsYou = Map<string, Set<string>>;

function needsYouIn(feed: AttentionFeed): NeedsYou {
  const result: NeedsYou = new Map();
  for (const project of Object.values(feed)) {
    const agents = new Set<string>();
    for (const record of project.attention) {
      if (record.level === "needs_you") agents.add(record.agentId);
    }
    if (agents.size > 0) result.set(project.projectId, agents);
  }
  return result;
}

function anyEntered(now: NeedsYou, before: NeedsYou): boolean {
  for (const [projectId, agents] of now) {
    const known = before.get(projectId);
    for (const agentId of agents) if (!known?.has(agentId)) return true;
  }
  return false;
}

/**
 * Feeds the global attention feed, live events and the current theme to the soundscape. The chime
 * follows the feed, so an agent entering needs-you in any project chimes once; the tick and pop
 * follow the selected project's events. Nothing sounds until the viewer enables sound. Returns
 * the disposer.
 */
export function connectSoundscape(
  soundscape: ChimingSoundscape,
  { attention, data, theme }: SoundscapeSources,
) {
  const first = theme.getState();
  soundscape.setTheme(first.themeId);
  soundscape.setHistory(first.history);

  /** Who was in needs-you at the last ready feed; undefined until the feed is trusted. */
  let baseline: NeedsYou | undefined;
  const follow = ({ feed, ready }: { feed: AttentionFeed; ready: boolean }) => {
    if (!ready) {
      baseline = undefined;
      return;
    }
    const now = needsYouIn(feed);
    // The first ready snapshot is what was already waiting, not news.
    if (baseline !== undefined && anyEntered(now, baseline)) soundscape.chime();
    baseline = now;
  };
  follow(attention.getState());

  const offAttention = attention.subscribe(follow);
  const offEvents = data.onEvent((event) => soundscape.handleEvent(event));
  const offTheme = theme.subscribe((state, prev) => {
    if (state.themeId !== prev.themeId) soundscape.setTheme(state.themeId);
    if (state.history !== prev.history) soundscape.setHistory(state.history);
  });
  return () => {
    offAttention();
    offEvents();
    offTheme();
  };
}
