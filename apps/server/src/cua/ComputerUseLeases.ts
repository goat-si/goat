/**
 * ComputerUseLeases - who may use this host's screen without a person at the keyboard.
 *
 * An unattended thread's admission is its approved computer_use.grant handoff: the lease is
 * active while that handoff is completed and before its expiry, so the event log is the only
 * record and a restart neither loses nor extends one. Ending early moves the handoff to
 * cancelled. Changes are signalled so lease proxies stop without waiting for their next call.
 *
 * @module ComputerUseLeases
 */
import {
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  Handoff,
  type ThreadId,
  type TurnItemId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { resolveSelfInvocation, type SelfInvocation } from "@goat/shared/nodeRuntime";

import * as ChannelBotDirectory from "../channels/ChannelBotDirectory.ts";

export class ComputerUseLeaseError extends Schema.TaggedError<ComputerUseLeaseError>()(
  "ComputerUseLeaseError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read computer use admissions.";
  }
}

export interface ComputerUseLease {
  readonly threadId: ThreadId;
  readonly handoffId: TurnItemId;
  readonly expiresAt: DateTime.Utc;
}

/** Why a thread runs without a person directing it; see ComputerUseOrigin. */
export type ChannelOrigin = "goat_bot" | "channel_task";

export type ComputerUseLeaseState =
  | { readonly _tag: "active"; readonly lease: ComputerUseLease }
  | { readonly _tag: "ended"; readonly reason: "expired" | "revoked" };

export class ComputerUseLeases extends Context.Service<
  ComputerUseLeases,
  {
    /** The thread's live admission, if any. */
    readonly active: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<ComputerUseLease>, ComputerUseLeaseError>;
    /** The live admission on this host held by a thread other than `except`. */
    readonly holder: (
      except?: ThreadId,
    ) => Effect.Effect<Option.Option<ComputerUseLease>, ComputerUseLeaseError>;
    /** Whether the thread is the GOAT Bot thread. Channel workers are known by their id. */
    readonly channelOrigin: (
      threadId: ThreadId,
    ) => Effect.Effect<ChannelOrigin | undefined, ComputerUseLeaseError>;
    /** Where one admission stands, for the proxy started with it. */
    readonly state: (
      threadId: ThreadId,
      handoffId: string,
    ) => Effect.Effect<ComputerUseLeaseState, ComputerUseLeaseError>;
    /** Wakes after any admission may have started or ended. Subscribe before reading. */
    readonly subscribe: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
    readonly changed: Effect.Effect<void>;
    /** How this server starts its own lease proxy subcommand. */
    readonly proxy: SelfInvocation | undefined;
  }
>()("goat/cua/ComputerUseLeases") {}

const decodeHandoff = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(Handoff)),
);

/** A completed grant before its expiry. A grant without an expiry is never live. */
const leaseOf = (handoff: Handoff, now: DateTime.Utc): Option.Option<ComputerUseLease> =>
  handoff.target.path === COMPUTER_USE_GRANT_HANDOFF_PATH &&
  handoff.state === "completed" &&
  handoff.expiresAt !== null &&
  DateTime.toEpochMillis(handoff.expiresAt) > DateTime.toEpochMillis(now)
    ? Option.some({
        threadId: handoff.requestedBy.threadId,
        handoffId: handoff.handoffId,
        expiresAt: handoff.expiresAt,
      })
    : Option.none();

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const directory = yield* ChannelBotDirectory.ChannelBotDirectory;
  const signals = yield* PubSub.sliding<void>(16);
  const proxy = Option.getOrUndefined(yield* resolveSelfInvocation().pipe(Effect.option));

  const live = Effect.fn("ComputerUseLeases.live")(function* (threadId?: ThreadId) {
    const rows = yield* sql<{ handoff_json: string | null }>`
      SELECT json_extract(payload_json, '$.handoff') AS handoff_json
      FROM orchestration_v2_projection_turn_items
      WHERE type = 'human_handoff' AND status = 'completed'
        AND json_extract(payload_json, '$.handoff.target.path') = ${COMPUTER_USE_GRANT_HANDOFF_PATH}
        ${threadId === undefined ? sql`` : sql`AND thread_id = ${threadId}`}
    `.pipe(Effect.mapError((cause) => new ComputerUseLeaseError({ cause })));
    const now = yield* DateTime.now;
    const leases: Array<ComputerUseLease> = [];
    for (const row of rows) {
      if (row.handoff_json === null) continue;
      const handoff = yield* decodeHandoff(row.handoff_json).pipe(
        Effect.mapError((cause) => new ComputerUseLeaseError({ cause })),
      );
      const lease = leaseOf(handoff, now);
      if (Option.isSome(lease)) leases.push(lease.value);
    }
    return [...leases].sort(
      (a, b) => DateTime.toEpochMillis(b.expiresAt) - DateTime.toEpochMillis(a.expiresAt),
    );
  });

  const state = Effect.fn("ComputerUseLeases.state")(function* (
    threadId: ThreadId,
    handoffId: string,
  ) {
    const rows = yield* sql<{ handoff_json: string | null }>`
      SELECT json_extract(payload_json, '$.handoff') AS handoff_json
      FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${threadId} AND turn_item_id = ${handoffId} AND type = 'human_handoff'
    `.pipe(Effect.mapError((cause) => new ComputerUseLeaseError({ cause })));
    const json = rows[0]?.handoff_json;
    if (json == null) return { _tag: "ended", reason: "revoked" } as const;
    const handoff = yield* decodeHandoff(json).pipe(
      Effect.mapError((cause) => new ComputerUseLeaseError({ cause })),
    );
    const lease = leaseOf(handoff, yield* DateTime.now);
    if (Option.isSome(lease)) return { _tag: "active", lease: lease.value } as const;
    return {
      _tag: "ended",
      reason: handoff.state === "completed" || handoff.state === "expired" ? "expired" : "revoked",
    } as const;
  });

  return ComputerUseLeases.of({
    active: (threadId) =>
      live(threadId).pipe(Effect.map((leases) => Option.fromNullishOr(leases[0]))),
    holder: (except) =>
      live().pipe(
        Effect.map((leases) =>
          Option.fromNullishOr(leases.find((lease) => lease.threadId !== except)),
        ),
      ),
    channelOrigin: Effect.fn("ComputerUseLeases.channelOrigin")(function* (threadId) {
      const read = <A>(effect: Effect.Effect<A, ChannelBotDirectory.ChannelBotDirectoryError>) =>
        effect.pipe(Effect.mapError((cause) => new ComputerUseLeaseError({ cause })));
      if (yield* read(directory.isBotThread(threadId))) return "goat_bot" as const;
      return undefined;
    }),
    state,
    subscribe: PubSub.subscribe(signals),
    changed: PubSub.publish(signals, undefined).pipe(Effect.asVoid),
    proxy,
  });
});

export const layer = Layer.effect(ComputerUseLeases, make).pipe(
  Layer.provide(ChannelBotDirectory.layer),
);
