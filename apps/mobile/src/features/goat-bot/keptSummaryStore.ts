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
  read: (id: EnvironmentId, kind: KeptKind) => Promise<string | null>;
  write: (id: EnvironmentId, kind: KeptKind, value: string) => Promise<void>;
  remove: (id: EnvironmentId, kind: KeptKind) => Promise<void>;
  clear: () => Promise<void>;
}

interface ReadLease {
  readonly id: EnvironmentId;
  readonly writtenAt: Partial<Record<KeptKind, number>>;
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
  // A native write may already be running when a refusal arrives. Deletion queues behind it,
  // and the lease invalidates anything that has not yet reached storage or returned to a reader.
  const serialized = <A>(action: () => Promise<A>): Promise<A> => {
    const work = tail.then(action);
    tail = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  };
  const isCurrent = (lease: ReadLease) => leases.get(lease.id) === lease;
  return {
    lease(id: EnvironmentId) {
      const previous = leases.get(id);
      if (previous !== undefined) return previous;
      const lease: ReadLease = { id, writtenAt: {} };
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
        if (!isCurrent(lease) || scopes.length === 0) return null;
        const raw = await storage.read(lease.id, kind);
        if (raw === null || !isCurrent(lease)) return null;
        const entry = Option.getOrNull(decoders[kind](raw));
        if (entry === null || now >= entry.readAt + KEPT_SUMMARY_TTL) {
          await storage.remove(lease.id, kind);
          return null;
        }
        if (!scopes.includes(entry.scope)) return null;
        return entry;
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
        if (!isCurrent(lease) || readAt < (lease.writtenAt[kind] ?? 0)) return;
        await storage.write(lease.id, kind, payload);
        lease.writtenAt[kind] = readAt;
      });
    },
    purge(id: EnvironmentId) {
      leases.delete(id);
      return serialized(async () => {
        for (const kind of KEPT_KINDS) await storage.remove(id, kind);
      });
    },
    purgeAll() {
      leases.clear();
      return serialized(storage.clear);
    },
  };
}
