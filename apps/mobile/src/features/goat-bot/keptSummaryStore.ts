import {
  BotId,
  BotProfile,
  ChannelOpenAsk,
  IsoDateTime,
  NonNegativeInt,
  type ChannelListBotsResult,
  type ChannelListOpenAsksResult,
  type EnvironmentId,
} from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const KEPT_KINDS = ["bots", "asks"] as const;
export type KeptKind = (typeof KEPT_KINDS)[number];
export const KEPT_SUMMARY_TTL = 7 * 24 * 60 * 60 * 1000;

const RosterRow = Schema.Struct({
  botId: BotId,
  role: BotProfile.fields.role,
  name: BotProfile.fields.name,
  avatar: BotProfile.fields.avatar,
  color: BotProfile.fields.color,
});
const AskRow = Schema.Struct({
  botId: BotId,
  kind: ChannelOpenAsk.fields.kind,
  taskId: ChannelOpenAsk.fields.taskId,
  askedAt: IsoDateTime,
});
const Bots = Schema.Array(RosterRow);
const Asks = Schema.Struct({
  asks: Schema.Array(AskRow),
  total: NonNegativeInt,
  truncated: Schema.Boolean,
});
const scopeAndTime = { scope: Schema.String, readAt: NonNegativeInt };
const decodeBots = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ ...scopeAndTime, kind: Schema.Literal("bots"), data: Bots }),
  ),
);
const decodeAsks = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ ...scopeAndTime, kind: Schema.Literal("asks"), data: Asks }),
  ),
);

interface Contents {
  bots: typeof Bots.Type;
  asks: typeof Asks.Type;
}
interface Answers {
  bots: ChannelListBotsResult;
  asks: ChannelListOpenAsksResult;
}
export interface KeptSummary<K extends KeptKind> {
  readonly kind: K;
  readonly scope: string;
  readonly readAt: number;
  readonly data: Contents[K];
}

interface Storage {
  read: (id: EnvironmentId, kind: KeptKind, scope: string) => Promise<string | null>;
  write: (id: EnvironmentId, kind: KeptKind, value: string, scope: string) => Promise<void>;
  remove: (id: EnvironmentId, kind: KeptKind, scope: string) => Promise<void>;
  markPurge: (id: EnvironmentId | null) => Promise<void>;
  deleteSummaries: (id: EnvironmentId | null) => Promise<void>;
  sweep: (expiredBefore?: number) => Promise<void>;
}

interface ReadLease {
  readonly id: EnvironmentId;
  readonly writtenAt: Record<KeptKind, Map<string, number>>;
}

const decoders: { [K in KeptKind]: (raw: unknown) => Option.Option<KeptSummary<K>> } = {
  bots: decodeBots,
  asks: decodeAsks,
};

const summarize: { [K in KeptKind]: (answer: Answers[K]) => Contents[K] } = {
  bots: ({ bots }: Answers["bots"]) =>
    bots
      .filter((bot) => bot.hidden !== true && bot.state !== "deleted")
      .map(({ botId, role, name, avatar, color }) => ({
        botId,
        role,
        name,
        avatar,
        ...(color === undefined ? {} : { color }),
      })),
  asks: ({ asks, total, truncated }: Answers["asks"]) => ({
    asks: asks.map(({ botId, kind, taskId, askedAt }) => ({ botId, kind, taskId, askedAt })),
    total,
    truncated,
  }),
};

export function createKeptSummaryStore(storage: Storage) {
  const leases = new Map<EnvironmentId, ReadLease>();
  let tail = Promise.resolve();
  const serialized = <A>(action: () => Promise<A>): Promise<A> => {
    const work = tail.then(action);
    tail = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  };
  const isCurrent = (lease: ReadLease) => leases.get(lease.id) === lease;
  const pending = new Map<EnvironmentId | null, () => Promise<void>>();
  let initialized = false;

  async function reconcile(now?: number): Promise<void> {
    if (initialized && pending.size === 0 && now === undefined) return;
    const marks = [...pending];
    for (const [, writeMark] of marks) await writeMark();
    await storage.sweep(now === undefined ? undefined : now - KEPT_SUMMARY_TTL);
    for (const [id, writeMark] of marks) {
      if (pending.get(id) === writeMark) pending.delete(id);
    }
    initialized = true;
  }

  function purge(id: EnvironmentId | null) {
    if (id === null) leases.clear();
    else leases.delete(id);
    // Write the tombstone immediately. Physical deletion waits for any native write in progress.
    const marked = storage.markPurge(id).then(
      () => true,
      () => false,
    );
    pending.set(id, async () => {
      if (await marked) return;
      try {
        await storage.markPurge(id);
      } catch {
        await storage.deleteSummaries(id);
      }
    });
    return serialized(() => reconcile());
  }

  return {
    lease(id: EnvironmentId) {
      const previous = leases.get(id);
      if (previous !== undefined) return previous;
      const lease: ReadLease = { id, writtenAt: { bots: new Map(), asks: new Map() } };
      leases.set(id, lease);
      return lease;
    },
    isCurrent,
    restore<K extends KeptKind>(
      lease: ReadLease,
      kind: K,
      scopes: ReadonlyArray<string>,
      now: number,
    ): Promise<KeptSummary<K> | null> {
      return serialized(async () => {
        if (!isCurrent(lease)) return null;
        await reconcile();
        let newest: KeptSummary<K> | null = null;
        for (const scope of scopes) {
          const raw = await storage.read(lease.id, kind, scope);
          if (!isCurrent(lease)) return null;
          if (raw === null) continue;
          const entry = Option.getOrNull(decoders[kind](raw));
          if (entry === null || entry.scope !== scope || now >= entry.readAt + KEPT_SUMMARY_TTL) {
            await storage.remove(lease.id, kind, scope);
          } else if (newest === null || entry.readAt > newest.readAt) {
            newest = entry;
          }
        }
        return isCurrent(lease) ? newest : null;
      });
    },
    keep<K extends KeptKind>(
      lease: ReadLease,
      kind: K,
      scope: string,
      readAt: number,
      answer: Answers[K],
    ) {
      const payload = JSON.stringify({ kind, scope, readAt, data: summarize[kind](answer) });
      return serialized(async () => {
        if (!isCurrent(lease)) return;
        await reconcile();
        const times = lease.writtenAt[kind];
        if (!isCurrent(lease) || readAt < (times.get(scope) ?? 0)) return;
        await storage.write(lease.id, kind, payload, scope);
        times.set(scope, readAt);
      });
    },
    maintain: (now: number) => serialized(() => reconcile(now)),
    purge,
    purgeAll: () => purge(null),
  };
}
