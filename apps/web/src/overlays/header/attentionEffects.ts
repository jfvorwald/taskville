import { useEffect } from "react";
import { projectSelection, selectProject } from "../../data/project.ts";
import { getSettingsStore } from "../settings/store.ts";
import {
  type DesktopNotification,
  decideDesktopNotifications,
  formatTabTitle,
  isDesktopNotificationsEnabled,
} from "./attention.ts";
import { type AttentionStore, attentionStore, useNeedsYouTotal } from "./attentionSync.ts";

/** Puts the number of agents that need you, in every project, in the tab title: `(2) Taskville`. */
export function useAttentionTabTitle(store: AttentionStore = attentionStore): void {
  const total = useNeedsYouTotal(store);
  useEffect(() => {
    document.title = formatTabTitle(total);
  }, [total]);
  // Leaving must not keep the last count on the tab.
  useEffect(
    () => () => {
      document.title = formatTabTitle(0);
    },
    [],
  );
}

const TEXT_LIMIT = 60;

/**
 * Project names and agent IDs are opaque text from outside, and an operating system shows a
 * notification outside the page. Control characters and bidi overrides are removed first, so the
 * characters kept are all visible ones, then the text is cut to `TEXT_LIMIT` characters.
 */
function plainText(text: string): string {
  const kept = [...text].filter((ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return !(
      c <= 0x1f ||
      c === 0x7f ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069)
    );
  });
  return kept.slice(0, TEXT_LIMIT).join("");
}

/** The viewer's `desktopNotifications` choice, read through the same shape the overlay host uses. */
function desktopNotificationsEnabled(): boolean {
  const settings = getSettingsStore();
  return isDesktopNotificationsEnabled({
    get: <T>(key: string, fallback: T): T => {
      const values = settings.getSnapshot() as unknown as Record<string, unknown>;
      return key in values ? (values[key] as T) : fallback;
    },
    set: (key, value) => settings.set(key as "desktopNotifications", value as boolean),
  });
}

function raise(notification: DesktopNotification): void {
  const shown = new Notification(`${plainText(notification.projectName)} needs you`, {
    body: `${plainText(notification.agentId)} is waiting for your answer`,
    // The request ID makes the tag, so the browser never shows the same request twice.
    tag: notification.key,
  });
  shown.onclick = () => {
    window.focus();
    selectProject(notification.projectId);
    shown.close();
  };
}

/**
 * Raises a desktop notification for each new needs-you in any project (opt-in, and only once the
 * browser granted permission). Stays quiet while the tab is visible and focused on that project.
 */
export function useDesktopNotifications(store: AttentionStore = attentionStore): void {
  useEffect(() => {
    if (typeof Notification === "undefined") return;
    return store.subscribe((state, before) => {
      if (state.feed === before.feed) return;
      const fired = decideDesktopNotifications({
        previous: before.ready ? before.feed : undefined,
        next: state.feed,
        enabled: desktopNotificationsEnabled(),
        permission: Notification.permission,
        view: {
          visible: document.visibilityState === "visible",
          focused: document.hasFocus(),
          projectId: projectSelection.getState().projectId,
        },
      });
      for (const notification of fired) raise(notification);
    });
  }, [store]);
}
