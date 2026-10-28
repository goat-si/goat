import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as AuxiliarySqlite from "../../storage/AuxiliarySqlite.ts";
import { ImessageDbError, openImessageChatDb } from "./imessageChatDb.ts";
// @effect-diagnostics nodeBuiltinImport:off -- synthetic SQLite and filesystem fixture only.
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ChannelGatewayError,
  type ChannelIdentityLinkConsumeInput,
  type ChannelInboundMessage,
  type ChannelIngestResult,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as ChannelLedger from "../ChannelLedger.ts";
import type { ImessageRow } from "./imessageChatDb.ts";
import * as ChannelGateway from "../ChannelGateway.ts";
import * as ChannelBotHome from "../ChannelBotHome.ts";
import * as ChannelTransport from "../ChannelTransport.ts";
import { deliveryIdFor } from "../channelIds.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { IMESSAGE_SETTINGS_FILE, type ImessageSettingsFile } from "./ImessageChannelSettings.ts";
import { makeImessageChannelRuntime } from "./ImessageChannelRuntime.ts";

const file: ImessageSettingsFile = {
  version: 1,
  enabled: true,
  connectionId: "imessage-000000000001",
  allowedHandles: ["+15550000000"],
  ownHandles: [],
  owner: {
    ownerId: "owner",
    principalId: "local-cli",
    displayName: "Owner",
    grantedScopes: ["orchestration:operate"],
    runtimeModeCeiling: "approval-required",
  },
};

describe("iMessage owner poll", () => {
  it.effect("preserves cursors through held reads and ingest, and replays a lost checkpoint", () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-imsg-replay-"));
      try {
        NodeFS.writeFileSync(NodePath.join(dir, IMESSAGE_SETTINGS_FILE), JSON.stringify(file));
        let clock = 1_000_000;
        let max = 0;
        let row: ImessageRow | undefined;
        let cursor: ChannelLedger.ImessageCursor | undefined;
        let failCheckpoint = false;
        let scans = 0;
        const queryStarted = yield* Deferred.make<void>();
        const queryResult = yield* Deferred.make<ReadonlyArray<ImessageRow>, ImessageDbError>();
        const ingestStarted = yield* Deferred.make<void>();
        const ingestContinue = yield* Deferred.make<void>();
        const checkpointStarted = yield* Deferred.make<void>();
        const checkpointContinue = yield* Deferred.make<void>();
        let held = false;
        let failRead = false;
        const stored = new Set<string>();
        let receipts = 0;
        const ledger = {
          isOwner: () => Effect.succeed(true),
          getImessageCursor: () => Effect.succeed(cursor),
          checkpointImessageCursor: ({ next }: { next: ChannelLedger.ImessageCursor }) =>
            Effect.gen(function* () {
              if (failCheckpoint) {
                failCheckpoint = false;
                return yield* new ChannelLedger.ChannelLedgerError({
                  reason: "persistence",
                  detail: "fixture",
                });
              }
              if (held) {
                yield* Deferred.succeed(checkpointStarted, undefined);
                yield* Deferred.await(checkpointContinue);
              }
              cursor = next;
            }),
          getDeliveryState: () => Effect.succeed(undefined),
        } as unknown as ChannelLedger.ChannelLedger["Service"];
        const gateway = {
          ingest: (message: ChannelInboundMessage) =>
            Effect.gen(function* () {
              if (held) {
                yield* Deferred.succeed(ingestStarted, undefined);
                yield* Deferred.await(ingestContinue);
              }
              receipts += 1;
              stored.add(message.idempotencyKey);
              return {} as ChannelIngestResult;
            }),
        } as unknown as ChannelGateway.ChannelGateway["Service"];
        const scope = yield* Scope.make();
        const runtime = makeImessageChannelRuntime({
          stateDir: dir,
          platform: "darwin",
          dbPath: "fixture",
          ledger,
          gateway,
          home: { requireHome: Effect.void },
          registry: {
            register: () => Effect.void,
          } as unknown as ChannelTransport.ChannelTransportRegistry["Service"],
          scope,
          now: () => clock,
          openDb: () =>
            Effect.succeed({
              maxRowId: () => Effect.succeed(max),
              rowsAfter: (after) =>
                Effect.gen(function* () {
                  scans += 1;
                  if (failRead) return yield* Effect.fail(new ImessageDbError("query_failed"));
                  if (held) {
                    yield* Deferred.succeed(queryStarted, undefined);
                    return yield* Deferred.await(queryResult);
                  }
                  return row && row.rowid > after ? [row] : [];
                }),
              rowById: (id) =>
                Effect.succeed(row === undefined ? undefined : { ...row, rowid: id }),
              close: () => Effect.void,
            }),
        });
        expect(yield* runtime.pollDue("owner")).toBe(0);
        expect(cursor).toEqual({ cursor: 0, pendingRowIds: [] });
        row = {
          rowid: 1,
          guid: "guid-1",
          text: "hello",
          attributedBody: null,
          handle_id: 1,
          is_from_me: 0,
          date: 0,
          date_read: null,
          cache_roomnames: null,
          associated_message_type: null,
          item_type: 0,
          balloon_bundle_id: null,
          sender_handle: "+15550000000",
          sender_service: "iMessage",
          chat_rowid: 1,
          chat_guid: "iMessage;-;+15550000000",
          chat_identifier: "+15550000000",
          style: 45,
          chat_join_count: 1,
        };
        max = 1;
        clock += 5_000;
        failCheckpoint = true;
        expect((yield* Effect.result(runtime.pollDue("owner")))._tag).toBe("Failure");
        expect(cursor?.cursor).toBe(0);
        clock += 5_000;
        expect(yield* runtime.pollDue("owner")).toBe(1);
        expect(cursor?.cursor).toBe(1);
        expect(receipts).toBe(2);
        expect(stored.size).toBe(1);
        held = true;
        clock += 5_000;
        row = { ...row, rowid: 2, guid: "guid-held" };
        max = 2;
        const pendingPoll = yield* runtime.pollDue("owner").pipe(Effect.forkChild);
        yield* Deferred.await(queryStarted);
        expect(cursor).toEqual({ cursor: 1, pendingRowIds: [] });
        yield* Deferred.succeed(queryResult, [row]);
        yield* Deferred.await(ingestStarted);
        expect(cursor).toEqual({ cursor: 1, pendingRowIds: [] });
        yield* Deferred.succeed(ingestContinue, undefined);
        yield* Deferred.await(checkpointStarted);
        expect(cursor).toEqual({ cursor: 1, pendingRowIds: [] });
        yield* Deferred.succeed(checkpointContinue, undefined);
        expect(yield* Fiber.join(pendingPoll)).toBe(1);
        expect(cursor).toEqual({ cursor: 2, pendingRowIds: [] });
        held = false;
        failRead = true;
        cursor = { cursor: 2, pendingRowIds: [1] };
        row = { ...row, chat_join_count: 0, chat_guid: null };
        clock += 5_000;
        expect((yield* Effect.result(runtime.pollDue("owner")))._tag).toBe("Failure");
        expect(cursor).toEqual({ cursor: 2, pendingRowIds: [1] });
        failRead = false;
        const pendingRowIds = Array.from({ length: 128 }, (_, index) => index + 1);
        cursor = { cursor: 129, pendingRowIds };
        row = { ...row, chat_join_count: 0, chat_guid: null };
        max = 129;
        clock += 5_000;
        const scansBefore = scans;
        expect(yield* runtime.pollDue("owner")).toBe(0);
        expect(scans).toBe(scansBefore);
        expect(cursor.pendingRowIds).toHaveLength(128);
        cursor = { cursor: 2, pendingRowIds: [] };
        max = 1;
        clock += 5_000;
        expect((yield* Effect.result(runtime.pollDue("owner")))._tag).toBe("Failure");
        expect(cursor.cursor).toBe(2);
        yield* Scope.close(scope, Exit.void);
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }),
  );
  it.effect("starts at max, checkpoints skips and admits only new direct text", () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-imsg-poll-"));
      const path = NodePath.join(dir, "fixture.sqlite");
      const writer = new NodeSqlite.DatabaseSync(path);
      try {
        NodeFS.writeFileSync(NodePath.join(dir, IMESSAGE_SETTINGS_FILE), JSON.stringify(file));
        writer.exec(`CREATE TABLE message (guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER,
        is_from_me INTEGER, date INTEGER, date_read INTEGER, cache_roomnames TEXT,
        associated_message_type INTEGER, item_type INTEGER, balloon_bundle_id TEXT);
        CREATE TABLE handle (id TEXT, service TEXT);
        CREATE TABLE chat (guid TEXT, chat_identifier TEXT, style INTEGER);
        CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);
        INSERT INTO handle VALUES ('+15550000000','iMessage');
        INSERT INTO chat VALUES ('iMessage;-;+15550000000','+15550000000',45);`);
        const insert = (id: string, own = 0, text = id, joined = true) => {
          const row = writer
            .prepare(
              "INSERT INTO message (guid,text,handle_id,is_from_me,date,item_type) VALUES (?,?,?,?,?,?)",
            )
            .run(id, text, 1, own, 0, 0);
          if (joined)
            writer.prepare("INSERT INTO chat_message_join VALUES (?,1)").run(row.lastInsertRowid);
          return Number(row.lastInsertRowid);
        };
        insert("history");
        const accepted: ChannelInboundMessage[] = [];
        let clock = 1_000_000;
        const layer = Layer.mergeAll(
          ChannelLedger.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
          ChannelTransport.layer,
          AuxiliarySqlite.layer,
        ).pipe(Layer.provide(NodeServices.layer));
        yield* Effect.gen(function* () {
          const ledger = yield* ChannelLedger.ChannelLedger;
          yield* ledger.claimOwnership({
            token: "owner-a",
            now: "2026-10-19T00:00:00.000Z",
            staleBefore: "2026-10-18T00:00:00.000Z",
          });
          const gateway = {
            ingest: (message: ChannelInboundMessage) =>
              Effect.gen(function* () {
                if (message.externalMessageId === "failed")
                  return yield* new ChannelGatewayError({ reason: "persistence_failed" });
                accepted.push(message);
                return {} as ChannelIngestResult;
              }),
            linkIdentity: (message: ChannelIdentityLinkConsumeInput) =>
              Effect.gen(function* () {
                const causeKey = "link:" + message.connectionId + ":" + message.idempotencyKey;
                const deliveryId = deliveryIdFor(causeKey);
                yield* ledger.enqueueDeliveries(
                  [
                    {
                      deliveryId,
                      causeKey,
                      message: {
                        deliveryId,
                        destination: message.replyAddress,
                        kind: "receipt",
                        text: "Invalid link",
                      },
                    },
                  ],
                  "2026-10-19T00:00:00.000Z",
                );
                return yield* new ChannelGatewayError({ reason: "forbidden" });
              }),
          } as unknown as ChannelGateway.ChannelGateway["Service"];
          let homeAvailable = true;
          const home = {
            requireHome: Effect.suspend(() =>
              homeAvailable
                ? Effect.void
                : Effect.fail(new ChannelGatewayError({ reason: "not_home" })),
            ),
          } as ChannelBotHome.ChannelBotHome["Service"];
          const reader = yield* AuxiliarySqlite.AuxiliarySqlite;
          const openDb = (file: string) =>
            openImessageChatDb(file).pipe(
              Effect.provideService(AuxiliarySqlite.AuxiliarySqlite, reader),
            );
          const registry = yield* ChannelTransport.ChannelTransportRegistry;
          const scope = yield* Scope.make();
          const runtime = makeImessageChannelRuntime({
            stateDir: dir,
            platform: "darwin",
            dbPath: path,
            openDb,
            ledger,
            gateway,
            home,
            registry,
            scope,
            now: () => clock,
          });
          expect(yield* runtime.pollDue("owner-a")).toBe(0);
          expect(Option.isSome(yield* registry.resolve("imessage"))).toBe(true);
          expect((yield* ledger.getImessageCursor(file.connectionId))?.cursor).toBe(1);
          insert("own", 1);
          insert("new");
          clock += 5_000;
          expect(yield* runtime.pollDue("owner-a")).toBe(2);
          expect(accepted.map((message) => message.externalMessageId)).toEqual(["new"]);
          expect((yield* ledger.getImessageCursor(file.connectionId))?.cursor).toBe(3);
          insert("bad-link", 0, "link 000000");
          insert("after");
          clock += 5_000;
          expect(yield* runtime.pollDue("owner-a")).toBe(2);
          expect(accepted.map((message) => message.externalMessageId)).toEqual(["new", "after"]);
          expect((yield* ledger.getImessageCursor(file.connectionId))?.cursor).toBe(5);
          const late = insert("late", 0, "late", false);
          clock += 5_000;
          expect(yield* runtime.pollDue("owner-a")).toBe(1);
          expect((yield* ledger.getImessageCursor(file.connectionId))?.pendingRowIds).toEqual([
            late,
          ]);
          writer.prepare("INSERT INTO chat_message_join VALUES (?,1)").run(late);
          clock += 5_000;
          expect(yield* runtime.pollDue("owner-a")).toBe(1);
          expect(accepted.map((message) => message.externalMessageId)).toEqual([
            "new",
            "after",
            "late",
          ]);
          expect((yield* ledger.getImessageCursor(file.connectionId))?.pendingRowIds).toEqual([]);
          insert("failed");
          clock += 5_000;
          expect((yield* Effect.result(runtime.pollDue("owner-a")))._tag).toBe("Failure");
          expect((yield* ledger.getImessageCursor(file.connectionId))?.cursor).toBe(late);
          homeAvailable = false;
          clock += 5_000;
          expect(yield* runtime.pollDue("owner-a")).toBe(0);
          const transport = Option.getOrThrow(yield* registry.resolve("imessage"));
          const blocked = yield* Effect.result(
            transport.send({
              deliveryId: "delivery" as never,
              destination: {
                kind: "imessage",
                connectionId: file.connectionId,
                chatGuid: "iMessage;-;+15550000000",
              },
              kind: "receipt",
              text: "No real send",
            }),
          );
          expect(blocked._tag).toBe("Failure");
          yield* Scope.close(scope, Exit.void);
          expect(Option.isNone(yield* registry.resolve("imessage"))).toBe(true);
          const otherScope = yield* Scope.make();
          const nonMac = makeImessageChannelRuntime({
            stateDir: dir,
            platform: "linux",
            dbPath: path,
            openDb,
            ledger,
            gateway,
            home,
            registry,
            scope: otherScope,
            now: () => clock,
          });
          expect(yield* nonMac.pollDue("owner-a")).toBe(0);
          expect(Option.isNone(yield* registry.resolve("imessage"))).toBe(true);
          yield* Scope.close(otherScope, Exit.void);
          NodeFS.writeFileSync(
            NodePath.join(dir, IMESSAGE_SETTINGS_FILE),
            JSON.stringify({ ...file, enabled: false }),
          );
          homeAvailable = true;
          expect(yield* runtime.pollDue("owner-a")).toBe(0);
          clock += 5_000;
          expect(yield* runtime.pollDue("other-owner")).toBe(0);
        }).pipe(Effect.provide(layer), Effect.scoped);
      } finally {
        writer.close();
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }),
  );
});
