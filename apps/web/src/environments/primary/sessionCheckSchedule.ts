import type { EnvironmentConnectionPresentation } from "@goat/client-runtime/connection";

import type { PrimarySessionAnswer } from "./auth";

/** Gaps between reads after a dropped socket: doubling from 5 s to 160 s, then every 5 minutes. */
const DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000] as const;
const STEADY_MS = 300_000;

type Connection = Pick<EnvironmentConnectionPresentation, "phase" | "failure">;

export interface PrimarySessionCheckSources {
  /** This tab's own server's connection, or null before it is known. */
  readonly connection: () => Connection | null;
  readonly subscribeConnection: (listener: () => void) => () => void;
  readonly visible: () => boolean;
  readonly subscribeVisible: (listener: () => void) => () => void;
  /** Whether this tab is a browser signed in to its own server by cookie. */
  readonly eligible: () => boolean;
  readonly probe: () => Promise<PrimarySessionAnswer>;
}

export interface PrimarySessionCheck {
  readonly subscribe: (listener: () => void) => () => void;
  /** True once the server said this tab's session is gone, until the tab connects again. */
  readonly revoked: () => boolean;
}

const delayAt = (step: number) => DELAYS_MS[step] ?? STEADY_MS;

const droppedSocket = (connection: Connection | null) =>
  connection !== null &&
  connection.phase !== "connected" &&
  connection.failure?.kind === "retrying" &&
  connection.failure.reason === "transport";

/**
 * A refused cookie looks like a dropped socket to the browser, so this asks auth/session, on a
 * backoff, one read at a time, only while visible, and only after the tab has connected once.
 * An episode lasts from a dropped socket until the next connect; a definite answer ends its reads.
 */
export function createPrimarySessionCheck(
  sources: PrimarySessionCheckSources,
): PrimarySessionCheck {
  const listeners = new Set<() => void>();
  // The first reader starts it; its listeners then stay for the tab's life so no connect or
  // visibility change is missed. With no reader mounted only the timer and the reads pause.
  let started = false;
  let connectedOnce = false;
  let revoked = false;
  let episode: { id: number; step: number; dueAt: number; done: boolean } | null = null;
  let episodes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let dueWhileHidden = false;

  const setRevoked = (next: boolean) => {
    if (revoked === next) return;
    revoked = next;
    for (const listener of listeners) listener();
  };
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    clearTimer();
    if (listeners.size === 0 || episode === null || episode.done || inFlight || dueWhileHidden) {
      return;
    }
    timer = setTimeout(read, Math.max(0, episode.dueAt - Date.now()));
  };
  const advance = () => {
    if (episode === null) return;
    episode.step += 1;
    episode.dueAt = Date.now() + delayAt(episode.step);
    schedule();
  };
  const settle = (id: number, answer: PrimarySessionAnswer) => {
    inFlight = false;
    if (episode === null || episode.id !== id) {
      schedule();
      return;
    }
    if (answer === "unknown") {
      advance();
      return;
    }
    episode.done = true;
    if (answer === "revoked") setRevoked(true);
  };
  const read = () => {
    timer = null;
    if (episode === null || episode.done || inFlight) return;
    if (!sources.visible()) {
      dueWhileHidden = true;
      return;
    }
    if (!droppedSocket(sources.connection()) || !sources.eligible()) {
      advance();
      return;
    }
    inFlight = true;
    const id = episode.id;
    void sources.probe().then(
      (answer) => settle(id, answer),
      () => settle(id, "unknown"),
    );
  };
  const follow = () => {
    const connection = sources.connection();
    if (connection?.phase === "connected") {
      connectedOnce = true;
      episode = null;
      dueWhileHidden = false;
      clearTimer();
      setRevoked(false);
      return;
    }
    if (episode !== null || !connectedOnce || !droppedSocket(connection) || !sources.eligible()) {
      return;
    }
    episodes += 1;
    episode = { id: episodes, step: 0, dueAt: Date.now() + delayAt(0), done: false };
    schedule();
  };
  const onVisibility = () => {
    if (!dueWhileHidden || !sources.visible()) return;
    dueWhileHidden = false;
    schedule();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (!started) {
        started = true;
        sources.subscribeConnection(follow);
        sources.subscribeVisible(onVisibility);
        follow();
      }
      schedule();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) clearTimer();
      };
    },
    revoked: () => revoked,
  };
}
