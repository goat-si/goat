/**
 * Member bots: create, hide, delete, restore, and a reconciler for steps a crash left halfway.
 * Every step holds one permit, so a reconcile never interleaves with a delete or a restore.
 * Ingress reads the profile's state, never the thread, so a pending step only changes the sidebar.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- bot ids and step markers are random.
import * as NodeCrypto from "node:crypto";

import {
  BotId,
  type BotProfile,
  CHANNEL_GATEWAY_WS_METHODS,
  type ChannelCreateBotInput,
  type ChannelDeleteBotInput,
  ChannelGatewayError,
  type ChannelListBotsInput,
  type ChannelRestoreBotInput,
  type ChannelSetBotHiddenInput,
  type ChannelUpdateBotInput,
  MAIN_BOT_ID,
} from "@goat/contracts";
import { resolveGoatBotModelSelection } from "@goat/shared/serverSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ChannelBotHome from "./ChannelBotHome.ts";
import * as ChannelBotProfiles from "./ChannelBotProfiles.ts";
import type { ChannelConnectionOwner } from "./ChannelIngressContext.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { botProfileKey } from "./channelBotLedger.ts";
import { memberBotLaunchIdsFor, memberBotStepCommandIdFor } from "./channelIds.ts";

export type MemberBot = BotProfile;
type Owner = Pick<ChannelConnectionOwner, "ownerId">;
type MemberRecord = ChannelBotProfiles.MemberRecord;

export class ChannelBotMembers extends Context.Service<
  ChannelBotMembers,
  {
    readonly create: (
      input: ChannelCreateBotInput,
      owner: Owner,
    ) => Effect.Effect<MemberBot, ChannelGatewayError>;
    readonly setHidden: (
      input: ChannelSetBotHiddenInput,
      owner: Owner,
    ) => Effect.Effect<MemberBot, ChannelGatewayError>;
    /** Refused with bot_busy while the bot has open tasks or unanswered messages. */
    readonly remove: (
      input: ChannelDeleteBotInput,
      owner: Owner,
    ) => Effect.Effect<MemberBot, ChannelGatewayError>;
    readonly restore: (
      input: ChannelRestoreBotInput,
      owner: Owner,
    ) => Effect.Effect<MemberBot, ChannelGatewayError>;
    /** Finishes this owner's pending steps, then lists its bots, main first. */
    readonly list: (
      input: ChannelListBotsInput,
      owner: Owner,
    ) => Effect.Effect<ReadonlyArray<BotProfile>, ChannelGatewayError>;
    /** Every owner's unfinished creates and steps; failures are logged and retried later. */
    readonly reconcileAll: Effect.Effect<void>;
    readonly update: ChannelBotProfiles.ChannelBotProfiles["Service"]["update"];
  }
>()("goat/channels/ChannelBotMembers") {}

const BOT_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const newBotId = () =>
  BotId.make(Array.from(NodeCrypto.randomBytes(12), (byte) => BOT_ID_ALPHABET[byte % 32]).join(""));
const PROFILE_PREFIX = "bot-profile:";
/** At most this many active members per owner, and member records of any state. */
export const MEMBER_LIMIT = 50;
const MEMBER_RECORD_LIMIT = 500;
/** Unfinished members one reconcile pass takes; the next list or ownership takes the rest. */
const RECONCILE_BATCH = 100;
const createKey = (ownerId: string, clientRequestId: string) =>
  "bot-create:" + encodeURIComponent(ownerId) + ":" + encodeURIComponent(clientRequestId);
const CreateRecord = Schema.fromJsonString(Schema.Struct({ botId: BotId }));
const decodeCreate = Schema.decodeUnknownSync(CreateRecord);
const encodeCreate = Schema.encodeSync(CreateRecord);

const isGatewayError = Schema.is(ChannelGatewayError);
const failed = (cause: unknown) =>
  isGatewayError(cause) ? cause : new ChannelGatewayError({ reason: "persistence_failed" });
const fail = (reason: ChannelGatewayError["reason"]) => new ChannelGatewayError({ reason });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* ChannelLedger.ChannelLedger;
  const profiles = yield* ChannelBotProfiles.ChannelBotProfiles;
  const home = yield* ChannelBotHome.ChannelBotHome;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const permit = yield* Semaphore.make(1);
  const serial = <A, E, R>(effect: Effect.Effect<A, E, R>) => permit.withPermits(1)(effect);
  const now = Effect.map(DateTime.now, DateTime.formatIso);

  const readMember = (ownerId: string, botId: string) =>
    ChannelBotProfiles.readProfileRecord(sql, ownerId, botId).pipe(
      Effect.map((record) => (record?.role === "member" ? record : undefined)),
    );
  const writeMember = (ownerId: string, record: MemberRecord, at: string) =>
    sql`UPDATE channel_runtime_state SET value_json = ${ChannelBotProfiles.encodeProfile(record)},
      updated_at = ${at} WHERE key = ${botProfileKey(ownerId, record.botId)}`;

  /** Starts the member's session thread and records its ref; the same ids on every retry. */
  const launchMember = Effect.fn("ChannelBotMembers.launch")(function* (
    ownerId: string,
    record: MemberRecord,
  ) {
    if ((yield* ledger.getBotById(ownerId, record.botId)) !== undefined) return;
    const project = yield* folders.ensureBotProject;
    const settings = yield* serverSettings.getSettings;
    const ids = memberBotLaunchIdsFor(ownerId, record.botId);
    yield* launches.launch({
      commandId: ids.commandId,
      threadId: ids.threadId,
      projectId: project.projectId,
      title: record.name,
      modelSelection: record.defaultModelSelection ?? resolveGoatBotModelSelection(settings),
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      createdBy: "system",
      creationSource: "server",
    });
    yield* ledger.setMemberBotIfAbsent({
      ownerId,
      botId: record.botId,
      bot: {
        environmentId: record.environmentId,
        projectId: project.projectId,
        threadId: ids.threadId,
      },
      now: yield* now,
    });
  });

  /**
   * Runs the archive or unarchive a delete or restore committed, then clears exactly that marker;
   * a newer one stays and runs next.
   */
  const runStep = Effect.fn("ChannelBotMembers.runStep")(function* (
    ownerId: string,
    botId: string,
  ) {
    for (let pass = 0; pass < 3; pass += 1) {
      const record = yield* readMember(ownerId, botId);
      const step = record?.lifecycle;
      if (record === undefined || step === undefined) return;
      const threadId = record.sessionThreadId;
      const thread = yield* threads.getThreadRecords(threadId, []);
      const archive = step.pending === "archive";
      if (thread.thread.deletedAt === null && (thread.thread.archivedAt !== null) !== archive) {
        yield* threads.dispatch({
          type: archive ? "thread.archive" : "thread.unarchive",
          commandId: memberBotStepCommandIdFor(threadId, step.pending, step.at),
          threadId,
        });
      }
      yield* sql`UPDATE channel_runtime_state
        SET value_json = json_remove(value_json, '$.lifecycle'), updated_at = ${yield* now}
        WHERE key = ${botProfileKey(ownerId, botId)}
          AND json_extract(value_json, '$.lifecycle.at') = ${step.at}
          AND json_extract(value_json, '$.lifecycle.pending') = ${step.pending}`;
    }
  });

  const finishMember = Effect.fn("ChannelBotMembers.finish")(
    function* (ownerId: string, record: MemberRecord) {
      if (record.state !== "deleted") yield* launchMember(ownerId, record);
      if (record.lifecycle !== undefined) yield* runStep(ownerId, record.botId);
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("GOAT Bot member step failed; it runs again later", { cause }),
    ),
  );

  /** Members of one owner, or of every owner, that still have something to finish. */
  /** One batch of unfinished members after "after", in key order, and the last key read. */
  const unfinished = Effect.fn("ChannelBotMembers.unfinished")(function* (
    ownerId: string | undefined,
    after: string,
  ) {
    const prefix =
      ownerId === undefined ? PROFILE_PREFIX : PROFILE_PREFIX + encodeURIComponent(ownerId) + ":";
    const from = after > prefix ? after : prefix;
    // A member's ref key is its profile key with "bot: " in place of the profile prefix.
    const rows = yield* sql<{ readonly key: string }>`
        SELECT p.key FROM channel_runtime_state p
        WHERE p.key > ${from} AND p.key < ${prefix.slice(0, -1) + ";"}
          AND json_extract(p.value_json, '$.role') = 'member'
          AND (json_extract(p.value_json, '$.lifecycle.pending') IS NOT NULL
            OR (COALESCE(json_extract(p.value_json, '$.state'), 'active') = 'active'
              AND NOT EXISTS (SELECT 1 FROM channel_runtime_state r
                WHERE r.key = 'bot: ' || substr(p.key, ${PROFILE_PREFIX.length + 1}))))
        ORDER BY p.key LIMIT ${RECONCILE_BATCH}`;
    const found: Array<{ readonly ownerId: string; readonly record: MemberRecord }> = [];
    for (const row of rows) {
      const [owner, bot] = row.key.slice(PROFILE_PREFIX.length).split(":");
      if (owner === undefined || bot === undefined) continue;
      const memberOwner = decodeURIComponent(owner);
      const record = yield* readMember(memberOwner, decodeURIComponent(bot));
      if (record !== undefined) found.push({ ownerId: memberOwner, record });
    }
    return { found, last: rows.at(-1)?.key, full: rows.length === RECONCILE_BATCH };
  });

  /**
   * Walks every unfinished member in key order, one batch per permit, so a member that keeps
   * failing never holds back the ones after it and a long pass never blocks a person's step.
   */
  const reconcile = Effect.fn("ChannelBotMembers.reconcile")(
    function* (ownerId: string | undefined) {
      let after = "";
      for (;;) {
        const batch = yield* serial(
          unfinished(ownerId, after).pipe(
            Effect.tap(({ found }) =>
              Effect.forEach(found, (member) => finishMember(member.ownerId, member.record), {
                discard: true,
              }),
            ),
          ),
        );
        if (!batch.full || batch.last === undefined) return;
        after = batch.last;
      }
    },
    Effect.catchCause((cause) => Effect.logWarning("GOAT Bot member reconcile failed", { cause })),
  );

  const create: ChannelBotMembers["Service"]["create"] = (input, owner) =>
    serial(
      Effect.gen(function* () {
        yield* home.requireHome;
        const at = yield* now;
        const environmentId = yield* environment.getEnvironmentId;
        const record = yield* sql.withTransaction(
          Effect.gen(function* () {
            const key = createKey(owner.ownerId, input.clientRequestId);
            const known = yield* sql<{ readonly value_json: string }>`
              SELECT value_json FROM channel_runtime_state WHERE key = ${key}`;
            if (known[0] !== undefined) {
              const existing = yield* readMember(
                owner.ownerId,
                decodeCreate(known[0].value_json).botId,
              );
              if (existing === undefined) return yield* fail("persistence_failed");
              return existing;
            }
            const counts = yield* memberCounts(owner.ownerId);
            if (counts.active >= MEMBER_LIMIT || counts.total >= MEMBER_RECORD_LIMIT)
              return yield* fail("bot_limit");
            const botId = newBotId();
            const created: MemberRecord = {
              botId,
              role: "member",
              name: input.name,
              avatar: input.avatar,
              purpose: input.purpose,
              defaultModelSelection: input.defaultModelSelection,
              defaultProjectId: null,
              environmentId,
              sessionThreadId: memberBotLaunchIdsFor(owner.ownerId, botId).threadId,
              createdAt: at,
              updatedAt: at,
            };
            yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at) VALUES
              (${botProfileKey(owner.ownerId, botId)}, ${ChannelBotProfiles.encodeProfile(created)}, ${at})`;
            yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at)
              VALUES (${key}, ${encodeCreate({ botId })}, ${at})`;
            return created;
          }),
        );
        if (record.state !== "deleted") yield* launchMember(owner.ownerId, record);
        return ChannelBotProfiles.memberProfile(record);
      }).pipe(Effect.mapError(failed)),
    );

  /** One committed change to a member, then its thread step if the change set one. */
  const change = (
    owner: Owner,
    botId: BotId,
    next: (record: MemberRecord, at: string) => Effect.Effect<MemberRecord, ChannelGatewayError>,
  ) =>
    serial(
      Effect.gen(function* () {
        if (botId === MAIN_BOT_ID) return yield* fail("invalid_input");
        const record = yield* sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* readMember(owner.ownerId, botId);
            if (current === undefined) return yield* fail("not_found");
            const updated = yield* next(current, yield* now);
            if (updated !== current) yield* writeMember(owner.ownerId, updated, updated.updatedAt);
            return updated;
          }),
        );
        if (record.lifecycle !== undefined) yield* finishMember(owner.ownerId, record);
        const settled = (yield* readMember(owner.ownerId, botId)) ?? record;
        return ChannelBotProfiles.memberProfile(settled);
      }).pipe(Effect.mapError(failed)),
    );

  const marker = (pending: "archive" | "unarchive", at: string) => ({
    pending,
    at: at + "/" + NodeCrypto.randomBytes(4).toString("hex"),
  });

  const memberCounts = (ownerId: string) => {
    const prefix = PROFILE_PREFIX + encodeURIComponent(ownerId) + ":";
    return sql<{ readonly total: number; readonly active: number }>`
      SELECT COUNT(*) AS total, COALESCE(SUM(
        COALESCE(json_extract(value_json, '$.state'), 'active') = 'active'), 0) AS active
      FROM channel_runtime_state
      WHERE key >= ${prefix} AND key < ${prefix.slice(0, -1) + ";"}
        AND json_extract(value_json, '$.role') = 'member'`.pipe(
      Effect.map((rows) => rows[0] ?? { total: 0, active: 0 }),
    );
  };

  const hasOpenWork = (ownerId: string, botId: string) =>
    sql<{ readonly found: number }>`
      SELECT 1 AS found FROM channel_tasks WHERE owner_id = ${ownerId} AND bot_id = ${botId}
        AND status NOT IN ('completed', 'failed', 'cancelled')
      UNION ALL
      SELECT 1 AS found FROM channel_inbox WHERE owner_id = ${ownerId} AND bot_id = ${botId}
        AND state IN ('accepted', 'processing')
      LIMIT 1`.pipe(Effect.map((rows) => rows.length > 0));

  const remove: ChannelBotMembers["Service"]["remove"] = (input, owner) =>
    change(owner, input.botId, (record, at) =>
      Effect.gen(function* () {
        if (record.state === "deleted") return record;
        if (yield* hasOpenWork(owner.ownerId, record.botId).pipe(Effect.mapError(failed)))
          return yield* fail("bot_busy");
        return {
          ...record,
          state: "deleted" as const,
          lifecycle: marker("archive", at),
          updatedAt: at,
        };
      }),
    );

  const restore: ChannelBotMembers["Service"]["restore"] = (input, owner) =>
    change(owner, input.botId, (record, at) =>
      Effect.gen(function* () {
        if (record.state !== "deleted") return record;
        const counts = yield* memberCounts(owner.ownerId).pipe(Effect.mapError(failed));
        if (counts.active >= MEMBER_LIMIT) return yield* fail("bot_limit");
        return {
          ...record,
          state: "active" as const,
          lifecycle: marker("unarchive", at),
          updatedAt: at,
        };
      }),
    );

  const setHidden: ChannelBotMembers["Service"]["setHidden"] = (input, owner) =>
    change(owner, input.botId, (record, at) =>
      record.state === "deleted"
        ? Effect.fail(fail("not_found"))
        : Effect.succeed({ ...record, hidden: input.hidden, updatedAt: at }),
    );

  const list: ChannelBotMembers["Service"]["list"] = (input, owner) =>
    reconcile(owner.ownerId).pipe(
      Effect.andThen(profiles.list(owner, { includeDeleted: input.includeDeleted })),
    );

  return ChannelBotMembers.of({
    create,
    setHidden,
    remove,
    restore,
    list,
    reconcileAll: reconcile(undefined),
    update: profiles.update,
  });
});

export const layer = Layer.effect(ChannelBotMembers, make);

export const rpcHandlers = (service: ChannelBotMembers["Service"], owner: Owner) => ({
  [CHANNEL_GATEWAY_WS_METHODS.listBots]: (input: ChannelListBotsInput) =>
    service.list(input, owner).pipe(Effect.map((bots) => ({ bots }))),
  [CHANNEL_GATEWAY_WS_METHODS.updateBot]: (input: ChannelUpdateBotInput) =>
    service.update(input, owner).pipe(Effect.map((bot) => ({ bot }))),
  [CHANNEL_GATEWAY_WS_METHODS.createBot]: (input: ChannelCreateBotInput) =>
    service.create(input, owner).pipe(Effect.map((bot) => ({ bot }))),
  [CHANNEL_GATEWAY_WS_METHODS.setBotHidden]: (input: ChannelSetBotHiddenInput) =>
    service.setHidden(input, owner).pipe(Effect.map((bot) => ({ bot }))),
  [CHANNEL_GATEWAY_WS_METHODS.deleteBot]: (input: ChannelDeleteBotInput) =>
    service.remove(input, owner).pipe(Effect.map((bot) => ({ bot }))),
  [CHANNEL_GATEWAY_WS_METHODS.restoreBot]: (input: ChannelRestoreBotInput) =>
    service.restore(input, owner).pipe(Effect.map((bot) => ({ bot }))),
});
