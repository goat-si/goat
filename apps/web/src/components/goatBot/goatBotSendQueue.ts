import { randomUUID } from "~/lib/utils";

import type { GoatBotPendingInput } from "./goatBotRows";

type EntryState = "queued" | "sending" | "accepted" | "failed";

interface Entry {
  readonly clientKey: string;
  readonly text: string;
  readonly createdAt: string;
  state: EntryState;
  requestKey: string | null;
}

export interface GoatBotSendQueueOptions {
  /** Delivers one message. The key is the message's idempotency key on every attempt. */
  readonly send: (message: {
    readonly clientKey: string;
    readonly text: string;
  }) => Promise<{ readonly requestKey: string }>;
  /** Checked right before every attempt; when false the queue stops and waits for a retry. */
  readonly canDispatch: () => boolean;
  readonly onChange: () => void;
  readonly makeKey?: () => string;
  readonly now?: () => string;
}

export interface GoatBotSendQueue {
  /** Queues a message and returns its key. */
  readonly submit: (text: string) => string;
  /** Sends a failed message again under the same key. Ignored while it is in flight. */
  readonly retry: (clientKey: string) => void;
  /** Forgets accepted messages once their server rows exist. */
  readonly acknowledge: (requestKeys: ReadonlySet<string>) => void;
  readonly pendingInputs: () => ReadonlyArray<GoatBotPendingInput>;
}

/**
 * Sends GOAT Bot messages one at a time, in the order they were written, so
 * a quick second message can never land before the first. Each message keeps
 * one key for all attempts; the server treats a repeat as the same input.
 */
export function createGoatBotSendQueue(options: GoatBotSendQueueOptions): GoatBotSendQueue {
  const makeKey = options.makeKey ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());
  let entries: Entry[] = [];
  let busy = false;
  let snapshot: ReadonlyArray<GoatBotPendingInput> = [];

  const changed = () => {
    snapshot = entries.map((entry) => ({
      clientKey: entry.clientKey,
      text: entry.text,
      createdAt: entry.createdAt,
      state: entry.state === "failed" ? "failed" : "sending",
      requestKey: entry.requestKey,
    }));
    options.onChange();
  };

  const pump = () => {
    if (busy) return;
    const next = entries.find((entry) => entry.state === "queued");
    if (next === undefined) return;
    if (!options.canDispatch()) {
      for (const entry of entries) {
        if (entry.state === "queued") entry.state = "failed";
      }
      changed();
      return;
    }
    busy = true;
    next.state = "sending";
    changed();
    options
      .send({ clientKey: next.clientKey, text: next.text })
      .then(
        (result) => {
          next.state = "accepted";
          next.requestKey = result.requestKey;
        },
        () => {
          next.state = "failed";
        },
      )
      .finally(() => {
        busy = false;
        changed();
        pump();
      });
  };

  return {
    submit: (text) => {
      const clientKey = makeKey();
      entries = [
        ...entries,
        { clientKey, text, createdAt: now(), state: "queued", requestKey: null },
      ];
      changed();
      pump();
      return clientKey;
    },
    retry: (clientKey) => {
      const entry = entries.find((candidate) => candidate.clientKey === clientKey);
      if (entry?.state !== "failed") return;
      entry.state = "queued";
      changed();
      pump();
    },
    acknowledge: (requestKeys) => {
      const kept = entries.filter(
        (entry) =>
          !(
            entry.state === "accepted" &&
            entry.requestKey !== null &&
            requestKeys.has(entry.requestKey)
          ),
      );
      if (kept.length === entries.length) return;
      entries = kept;
      changed();
    },
    pendingInputs: () => snapshot,
  };
}
