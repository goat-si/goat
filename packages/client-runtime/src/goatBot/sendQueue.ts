import * as DateTime from "effect/DateTime";

import type { GoatBotRef } from "./availability.ts";
import type { GoatBotAttachmentLabel, GoatBotPendingInput } from "./rows.ts";

type EntryState = "queued" | "sending" | "accepted" | "failed";

interface Entry<A> {
  readonly clientKey: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<A>;
  readonly createdAt: string;
  readonly bot: GoatBotRef;
  state: EntryState;
  requestKey: string | null;
  rejectionReason: string | null;
}

export interface GoatBotSendQueueOptions<
  A extends GoatBotAttachmentLabel = GoatBotAttachmentLabel,
> {
  /**
   * Delivers one message. The key is the message's idempotency key on every attempt, so an
   * attempt must name the same files as the one before it.
   */
  readonly send: (message: {
    readonly clientKey: string;
    readonly text: string;
    readonly attachments: ReadonlyArray<A>;
    readonly receivedAt: string;
    readonly bot: GoatBotRef;
  }) => Promise<{ readonly requestKey: string; readonly rejected?: string }>;
  /** Checked right before every attempt; when false the queue stops and waits for a retry. */
  readonly canDispatch: (bot: GoatBotRef) => boolean;
  readonly onChange: () => void;
  readonly makeKey: () => string;
  readonly now?: () => string;
}

export interface GoatBotSendQueue<A extends GoatBotAttachmentLabel = GoatBotAttachmentLabel> {
  /** Queues a message, with any files to send along, and returns its key. */
  readonly submit: (text: string, bot: GoatBotRef, attachments?: ReadonlyArray<A>) => string;
  /** Sends a failed message again under the same key. Ignored while it is in flight. */
  readonly retry: (clientKey: string) => void;
  /** Forgets accepted messages once their server rows exist. */
  readonly acknowledge: (requestKeys: ReadonlySet<string>) => void;
  readonly pendingInputs: () => ReadonlyArray<GoatBotPendingInput>;
}

/**
 * Sends queued messages one at a time. Failed messages do not hold later ones;
 * a retry lands at its retry time. Each message keeps one key for all attempts.
 */
export function createGoatBotSendQueue<A extends GoatBotAttachmentLabel = GoatBotAttachmentLabel>(
  options: GoatBotSendQueueOptions<A>,
): GoatBotSendQueue<A> {
  const makeKey = options.makeKey;
  const now = options.now ?? (() => DateTime.formatIso(DateTime.nowUnsafe()));
  let entries: Entry<A>[] = [];
  let busy = false;
  let projectedKeys: ReadonlySet<string> = new Set();
  let snapshot: ReadonlyArray<GoatBotPendingInput> = [];

  const changed = () => {
    snapshot = entries.map((entry) => ({
      clientKey: entry.clientKey,
      text: entry.text,
      ...(entry.attachments.length === 0
        ? {}
        : { attachments: entry.attachments.map(({ id, type, name }) => ({ id, type, name })) }),
      createdAt: entry.createdAt,
      state: entry.state,
      requestKey: entry.requestKey,
      ...(entry.rejectionReason === null ? {} : { rejectionReason: entry.rejectionReason }),
    }));
    options.onChange();
  };

  const pump = () => {
    if (busy) return;
    const next = entries.find((entry) => entry.state === "queued");
    if (next === undefined) return;
    if (!options.canDispatch(next.bot)) {
      for (const entry of entries) {
        if (entry.state === "queued") entry.state = "failed";
      }
      changed();
      return;
    }
    busy = true;
    next.state = "sending";
    changed();
    (async () =>
      options.send({
        clientKey: next.clientKey,
        text: next.text,
        attachments: next.attachments,
        receivedAt: next.createdAt,
        bot: next.bot,
      }))()
      .then(
        (result) => {
          next.state = result.rejected === undefined ? "accepted" : "failed";
          next.rejectionReason = result.rejected ?? null;
          next.requestKey = result.requestKey;
          if (projectedKeys.has(result.requestKey) || projectedKeys.has(next.clientKey)) {
            entries = entries.filter((entry) => entry !== next);
          }
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
    submit: (text, bot, attachments = []) => {
      const clientKey = makeKey();
      entries = [
        ...entries,
        {
          clientKey,
          text,
          attachments,
          createdAt: now(),
          bot: { ...bot },
          state: "queued",
          requestKey: null,
          rejectionReason: null,
        },
      ];
      changed();
      pump();
      return clientKey;
    },
    retry: (clientKey) => {
      const entry = entries.find((candidate) => candidate.clientKey === clientKey);
      if (entry?.state !== "failed" || entry.rejectionReason !== null) return;
      entry.state = "queued";
      changed();
      pump();
    },
    acknowledge: (requestKeys) => {
      projectedKeys = requestKeys;
      const kept = entries.filter(
        (entry) =>
          !requestKeys.has(entry.clientKey) &&
          (entry.requestKey === null || !requestKeys.has(entry.requestKey)),
      );
      if (kept.length === entries.length) return;
      entries = kept;
      changed();
    },
    pendingInputs: () => snapshot,
  };
}
