import * as AuxiliarySqlite from "../../storage/AuxiliarySqlite.ts";
// @effect-diagnostics nodeBuiltinImport:off -- the local Messages path is fixed for this adapter.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@goat/shared/HostProcess";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as ServerConfig from "../../config.ts";
import * as ChannelBotHome from "../ChannelBotHome.ts";
import * as ChannelGateway from "../ChannelGateway.ts";
import * as ChannelLedger from "../ChannelLedger.ts";
import * as ChannelTransport from "../ChannelTransport.ts";
import { deliveryIdFor } from "../channelIds.ts";
import {
  classifyImessageDbError,
  ImessageDbError,
  openImessageChatDb,
  type ImessageChatDb,
  type ImessageRow,
} from "./imessageChatDb.ts";
import { loadImessageSettings, type ImessageSettings } from "./ImessageChannelSettings.ts";
import { admitImessageRow, classifyImessageText, toImessageInbound } from "./imessageRowMapping.ts";
import { makeImessageTransport, makeOsascriptImessageSender } from "./imessageSender.ts";

const BATCH = 50;
const PENDING_CAP = 128;
const POLL_MS = 5_000;

export class ImessageChannelRuntime extends Context.Service<
  ImessageChannelRuntime,
  {
    readonly pollDue: (
      ownerToken: string,
    ) => Effect.Effect<number, ChannelLedger.ChannelLedgerError>;
  }
>()("goat/channels/imessage/ImessageChannelRuntime") {}

export const layerUnavailable = Layer.succeed(
  ImessageChannelRuntime,
  ImessageChannelRuntime.of({ pollDue: () => Effect.succeed(0) }),
);

interface RuntimeInput {
  readonly stateDir: string;
  readonly platform: NodeJS.Platform;
  readonly dbPath: string;
  readonly ledger: ChannelLedger.ChannelLedger["Service"];
  readonly gateway: ChannelGateway.ChannelGateway["Service"];
  readonly home: Pick<ChannelBotHome.ChannelBotHome["Service"], "requireHome">;
  readonly registry: ChannelTransport.ChannelTransportRegistry["Service"];
  readonly scope: Scope.Scope;
  readonly openDb: (path: string) => Effect.Effect<ImessageChatDb, ImessageDbError>;
  readonly now?: () => number;
}

const failure = (detail: string) =>
  new ChannelLedger.ChannelLedgerError({ reason: "persistence", detail });
const databaseFailure = (cause: unknown) =>
  failure(
    "iMessage database " +
      (cause instanceof ImessageDbError ? cause.category : classifyImessageDbError(cause)),
  );

export function makeImessageChannelRuntime(input: RuntimeInput): ImessageChannelRuntime["Service"] {
  let nextDue = 0;
  let registeredConnection: string | undefined;
  const now = input.now ?? Date.now;
  const openDb = input.openDb;
  const settings = () =>
    loadImessageSettings({ stateDir: input.stateDir, platform: input.platform });
  const active = (connectionId: string) =>
    Effect.gen(function* () {
      const current = yield* settings();
      if (current?.connectionId !== connectionId) return false;
      const home = yield* Effect.result(input.home.requireHome);
      return home._tag === "Success";
    });
  const register = (current: ImessageSettings) =>
    Effect.gen(function* () {
      if (registeredConnection === current.connectionId) return;
      const transport = makeImessageTransport({
        connectionId: current.connectionId,
        sender: makeOsascriptImessageSender(),
        isActive: () => active(current.connectionId),
      });
      yield* input.registry
        .register(transport)
        .pipe(Effect.provideService(Scope.Scope, input.scope));
      registeredConnection = current.connectionId;
    });
  const checkpoint = (
    owner: string,
    current: ImessageSettings,
    expected: ChannelLedger.ImessageCursor | undefined,
    next: ChannelLedger.ImessageCursor,
  ) =>
    input.ledger.checkpointImessageCursor({
      owner,
      connectionId: current.connectionId,
      expected,
      next,
      now: DateTime.formatIso(DateTime.makeUnsafe(now())),
    });
  const ingestRow = (row: ImessageRow, current: ImessageSettings) =>
    Effect.gen(function* () {
      const classified = admitImessageRow(row, current);
      if (classified.type !== "message") return classified;
      const inbound = toImessageInbound(classified, current);
      const context = {
        ...current.owner,
        caller: {
          type: "transport" as const,
          kind: "imessage" as const,
          connectionId: current.connectionId,
        },
      };
      const command = classifyImessageText(classified.text);
      if (command.type === "link") {
        const linked = yield* Effect.result(
          input.gateway.linkIdentity(
            {
              connectionId: current.connectionId,
              externalActorId: classified.senderHandle,
              code: command.code,
              idempotencyKey: inbound.idempotencyKey,
              replyAddress: inbound.replyAddress,
            },
            context,
          ),
        );
        if (linked._tag === "Failure") {
          if (linked.failure.reason !== "forbidden") return yield* failure("iMessage link failed");
          const causeKey = "link:" + current.connectionId + ":" + inbound.idempotencyKey;
          const notice = yield* input.ledger.getDeliveryState(deliveryIdFor(causeKey));
          if (notice === undefined) return yield* failure("iMessage link notice absent");
        }
      } else if (command.type === "notice") {
        yield* input.gateway
          .requestNotice(
            {
              connectionId: current.connectionId,
              actor: inbound.actor,
              idempotencyKey: inbound.idempotencyKey,
              replyAddress: inbound.replyAddress,
              notice: command.notice,
            },
            context,
          )
          .pipe(Effect.mapError(() => failure("iMessage notice failed")));
      } else {
        yield* input.gateway
          .ingest(inbound, context)
          .pipe(Effect.mapError(() => failure("iMessage ingest failed")));
      }
      return classified;
    });
  const pollDue = (owner: string) =>
    Effect.gen(function* () {
      const current = yield* settings();
      if (current === undefined) return 0;
      if (!(yield* input.ledger.isOwner(owner))) return 0;
      if ((yield* Effect.result(input.home.requireHome))._tag === "Failure") return 0;
      yield* register(current);
      if (now() < nextDue) return 0;
      nextDue = now() + POLL_MS;
      const db = yield* openDb(input.dbPath).pipe(Effect.mapError(databaseFailure));
      return yield* Effect.gen(function* () {
        const initial = yield* input.ledger.getImessageCursor(current.connectionId);
        const max = yield* db.maxRowId().pipe(Effect.mapError(databaseFailure));
        if (initial === undefined) {
          yield* checkpoint(owner, current, undefined, { cursor: max, pendingRowIds: [] });
          return 0;
        }
        let cursor: ChannelLedger.ImessageCursor = initial;
        if (max < cursor.cursor) return yield* failure("iMessage database ROWID reset");
        let processed = 0;
        for (const id of cursor.pendingRowIds) {
          const row = yield* db.rowById(id).pipe(Effect.mapError(databaseFailure));
          if (row === undefined) return yield* failure("iMessage pending row missing");
          const result = yield* ingestRow(row, current);
          if (result.type === "pending_join") continue;
          const next = {
            cursor: cursor.cursor,
            pendingRowIds: cursor.pendingRowIds.filter((value) => value !== id),
          };
          yield* checkpoint(owner, current, cursor, next);
          cursor = next;
          processed += 1;
        }
        if (cursor.pendingRowIds.length >= PENDING_CAP) {
          yield* Effect.logWarning("iMessage pending join limit reached");
          return processed;
        }
        const rows = yield* db
          .rowsAfter(cursor.cursor, BATCH)
          .pipe(Effect.mapError(databaseFailure));
        for (const row of rows) {
          const result = yield* ingestRow(row, current);
          if (result.type === "pending_join" && cursor.pendingRowIds.length >= PENDING_CAP) {
            yield* Effect.logWarning("iMessage pending join limit reached");
            break;
          }
          const next = {
            cursor: row.rowid,
            pendingRowIds:
              result.type === "pending_join"
                ? [...cursor.pendingRowIds, row.rowid]
                : cursor.pendingRowIds,
          };
          yield* checkpoint(owner, current, cursor, next);
          cursor = next;
          processed += 1;
        }
        return processed;
      }).pipe(Effect.ensuring(db.close()));
    });
  return ImessageChannelRuntime.of({ pollDue });
}

export const makeLayerLive = (
  dbPath = NodePath.join(NodeOS.homedir(), "Library/Messages/chat.db"),
) =>
  Layer.effect(
    ImessageChannelRuntime,
    Effect.gen(function* () {
      const reader = yield* AuxiliarySqlite.AuxiliarySqlite;
      const config = yield* ServerConfig.ServerConfig;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const home = yield* ChannelBotHome.ChannelBotHome;
      const registry = yield* ChannelTransport.ChannelTransportRegistry;
      const platform = yield* HostProcess.Platform;
      const scope = yield* Effect.scope;
      return makeImessageChannelRuntime({
        stateDir: config.stateDir,
        platform,
        dbPath,
        openDb: (file) =>
          openImessageChatDb(file).pipe(
            Effect.provideService(AuxiliarySqlite.AuxiliarySqlite, reader),
          ),
        ledger,
        gateway,
        home,
        registry,
        scope,
      });
    }),
  ).pipe(Layer.provide(AuxiliarySqlite.layer));

export const layerLive = makeLayerLive();
