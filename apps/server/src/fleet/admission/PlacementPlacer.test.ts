// @effect-diagnostics nodeBuiltinImport:off - each test gets a scratch database folder.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ChatAttachmentId, type ChatAttachment, type ChatFileAttachment } from "@goat/contracts";
import { createPendingAttachmentId, resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as SshRemoteDispatch from "../../sshRemote/SshRemoteDispatch.ts";
import * as Attempts from "./PlacementAttempts.ts";
import * as Placer from "./PlacementPlacer.ts";
import { RETAIN_MS } from "./PlacementReservations.ts";

const T0 = Date.UTC(2026, 10, 1);
const freshFile = () =>
  NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "placement-placer-")),
    "state.sqlite",
  );
const database = (file: string) =>
  Layer.orDie(SqlitePersistence.layerFromPath(file).pipe(Layer.provide(NodeServices.layer)));

type Answer =
  | { readonly ok: true; readonly threadId: string; readonly runId: string | null }
  | { readonly ok: false; readonly error: SshRemoteDispatch.SshRemoteDispatchError };

interface Remote {
  readonly sent: Array<{
    readonly host: string;
    readonly placement: unknown;
    readonly title: string;
  }>;
  readonly archived: Array<string>;
  answers: Array<Answer>;
  archiveFails: boolean;
  /** Threads whose archive always fails. */
  readonly archiveFailsFor: Set<string>;
}

const remote = (): Remote => ({
  sent: [],
  archived: [],
  answers: [],
  archiveFails: false,
  archiveFailsFor: new Set(),
});

const dispatchFor = (fake: Remote) =>
  Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
    launchThread: (input) =>
      Effect.suspend(() => {
        fake.sent.push({ host: input.host ?? "", placement: input.placement, title: input.title });
        const answer = fake.answers.shift() ?? { ok: true as const, threadId: "t", runId: "r" };
        return answer.ok
          ? Effect.succeed({ threadId: answer.threadId, runId: answer.runId } as never)
          : Effect.fail(answer.error);
      }),
    callHostTool: (call) =>
      Effect.suspend(() => {
        if (
          fake.archiveFails ||
          fake.archiveFailsFor.has(String((call.arguments as { threadId: string }).threadId))
        )
          return Effect.fail(
            new SshRemoteDispatch.SshRemoteDispatchError({
              reason: "host_unavailable",
              message: "down",
            }),
          );
        fake.archived.push(String((call.arguments as { threadId: string }).threadId));
        return Effect.succeed({});
      }),
  });

const placerOn = (file: string, fake: Remote) =>
  Placer.layer.pipe(
    Layer.provideMerge(Attempts.layer),
    Layer.provide(dispatchFor(fake)),
    Layer.provideMerge(database(file)),
    Layer.provideMerge(
      ServerConfig.layerTest(
        NodePath.dirname(file),
        NodePath.join(NodePath.dirname(file), "home"),
      ).pipe(Layer.provide(NodeServices.layer)),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const launch = (title = "Work") => ({
  cwd: "/repo",
  workspace: { type: "cwd" as const },
  title,
  message: "do it",
  runtimeMode: "full-access" as const,
  callerRuntimeMode: "full-access" as const,
});

const placeOn = (host: string, title?: string, ownerKey = "goal:g:a1") =>
  Effect.flatMap(Placer.PlacementPlacer, (placer) =>
    placer.placeRemote({
      ownerKey,
      host,
      launch: launch(title),
      authorize: Effect.succeed("full-access" as const),
    }),
  );

const lost = () =>
  ({
    ok: false,
    error: new SshRemoteDispatch.SshRemoteDispatchError({
      reason: "ssh_failed",
      message: "connection dropped after the request was sent",
      launchMayHaveStarted: true,
    }),
  }) as const;
const refused = (
  classification: string,
  extra: { threadId?: string; mayHaveStarted?: boolean } = {},
) =>
  ({
    ok: false,
    error: new SshRemoteDispatchError({
      reason: "remote_refused",
      message: classification,
      remoteClassification: classification,
      launchMayHaveStarted: extra.mayHaveStarted ?? false,
      ...(extra.threadId === undefined ? {} : { remoteThreadId: extra.threadId }),
    }),
  }) as const;
const SshRemoteDispatchError = SshRemoteDispatch.SshRemoteDispatchError;

describe("the placer's attempt history", () => {
  it.effect("one current attempt per owner, even when two recoveries race", () =>
    Effect.gen(function* () {
      const attempts = yield* Attempts.PlacementAttempts;
      const results = yield* Effect.all(
        Array.from({ length: 5 }, () =>
          attempts.resolve({ ownerKey: "o", targetHost: "a", payloadJson: "{}", now: T0 }),
        ),
        { concurrency: "unbounded" },
      );
      assert.strictEqual(results.filter((result) => result._tag === "Created").length, 1);
      assert.isTrue(
        results.every((result) => ("attempt" in result ? result.attempt?.attempt : null) === 0),
      );
      const elsewhere = yield* attempts.resolve({
        ownerKey: "o",
        targetHost: "b",
        payloadJson: "{}",
        now: T0,
      });
      assert.strictEqual(elsewhere._tag, "PinnedElsewhere");
    }).pipe(Effect.provide(Layer.provideMerge(Attempts.layer, database(freshFile())))),
  );

  it.effect(
    "a started attempt allocates nothing new, as after a crash between recording it and settling the claim",
    () =>
      Effect.gen(function* () {
        const attempts = yield* Attempts.PlacementAttempts;
        yield* attempts.resolve({ ownerKey: "o", targetHost: "a", payloadJson: "{}", now: T0 });
        yield* attempts.recordStarted({ ownerKey: "o", attempt: 0, threadId: "t", runId: "r" });
        const again = yield* attempts.resolve({
          ownerKey: "o",
          targetHost: "b",
          payloadJson: "{}",
          now: T0,
        });
        assert.deepStrictEqual(
          [again._tag, "attempt" in again ? again.attempt?.attempt : null],
          ["Started", 0],
        );
      }).pipe(Effect.provide(Layer.provideMerge(Attempts.layer, database(freshFile())))),
  );

  it.effect(
    "after not started or a rerun the next key gets a new attempt number whatever the clock reads, also after settled history is pruned",
    () =>
      Effect.gen(function* () {
        const attempts = yield* Attempts.PlacementAttempts;
        yield* attempts.resolve({ ownerKey: "o", targetHost: "a", payloadJson: "{}", now: T0 });
        yield* attempts.recordNotStarted({ ownerKey: "o", attempt: 0, threadId: null });
        // Clock rolled back: the attempt number still moves on.
        const second = yield* attempts.resolve({
          ownerKey: "o",
          targetHost: "b",
          payloadJson: "{}",
          now: T0 - 1000,
        });
        assert.deepStrictEqual(
          [second._tag, "attempt" in second ? second.attempt?.attempt : null],
          ["Created", 1],
        );
        assert.isTrue(
          yield* attempts.chooseRunAgain({
            ownerKey: "o",
            attempt: 1,
            decidedBy: "person",
            now: T0,
          }),
        );
        assert.isFalse(
          yield* attempts.chooseRunAgain({
            ownerKey: "o",
            attempt: 1,
            decidedBy: "person",
            now: T0,
          }),
        );
        const third = yield* attempts.resolve({
          ownerKey: "o",
          targetHost: "c",
          payloadJson: "{}",
          now: T0,
        });
        assert.deepStrictEqual(
          [third._tag, "attempt" in third ? third.attempt?.attempt : null],
          ["Created", 2],
        );
        // The old attempt stays unknown with the person's choice; a late success is still recorded on it.
        assert.isTrue(
          yield* attempts.recordStarted({
            ownerKey: "o",
            attempt: 1,
            threadId: "late",
            runId: "r",
          }),
        );
        const latest = yield* attempts.lookup("o");
        assert.deepStrictEqual(
          latest._tag === "Found" ? [latest.attempt.attempt, latest.attempt.state] : latest,
          [2, "unknown"],
        );
        yield* attempts.recordNotStarted({ ownerKey: "o", attempt: 2, threadId: null });
        // Settled history goes after 30 days, except the latest attempt, which still answers.
        assert.strictEqual(yield* attempts.prune(T0 + RETAIN_MS + 1), 2);
        const fourth = yield* attempts.resolve({
          ownerKey: "o",
          targetHost: "a",
          payloadJson: "{}",
          now: T0,
        });
        assert.deepStrictEqual(
          [fourth._tag, "attempt" in fourth ? fourth.attempt?.attempt : null],
          ["Created", 3],
        );
      }).pipe(Effect.provide(Layer.provideMerge(Attempts.layer, database(freshFile())))),
  );

  it.effect(
    "a prune past a clock jump keeps the latest attempt's outcome, so an older decided attempt cannot free another key",
    () =>
      Effect.gen(function* () {
        const attempts = yield* Attempts.PlacementAttempts;
        yield* attempts.resolve({ ownerKey: "o", targetHost: "a", payloadJson: "{}", now: T0 });
        yield* attempts.chooseRunAgain({ ownerKey: "o", attempt: 0, decidedBy: "p", now: T0 });
        yield* attempts.resolve({ ownerKey: "o", targetHost: "b", payloadJson: "{}", now: T0 });
        // Attempt 1 started, and the claim was not settled before the clock jumped forward.
        yield* attempts.recordStarted({ ownerKey: "o", attempt: 1, threadId: "t1", runId: "r" });
        yield* attempts.prune(T0 + RETAIN_MS + 1);
        const again = yield* attempts.resolve({
          ownerKey: "o",
          targetHost: "c",
          payloadJson: "{}",
          now: T0 + RETAIN_MS + 1,
        });
        assert.deepStrictEqual(
          [again._tag, "attempt" in again ? again.attempt?.attempt : null],
          ["Started", 1],
        );
      }).pipe(Effect.provide(Layer.provideMerge(Attempts.layer, database(freshFile())))),
  );

  it.effect(
    "a missing latest attempt stays unknown whatever older rows say, until a person's recorded choice frees exactly one successor",
    () =>
      Effect.gen(function* () {
        const attempts = yield* Attempts.PlacementAttempts;
        const sql = yield* SqlClient.SqlClient;
        yield* attempts.resolve({ ownerKey: "o", targetHost: "a", payloadJson: "{}", now: T0 });
        yield* attempts.chooseRunAgain({ ownerKey: "o", attempt: 0, decidedBy: "p", now: T0 });
        yield* attempts.resolve({ ownerKey: "o", targetHost: "b", payloadJson: "{}", now: T0 });
        yield* attempts.recordStarted({ ownerKey: "o", attempt: 1, threadId: "t1", runId: "r" });
        yield* sql`DELETE FROM placement_attempts WHERE owner_key = 'o' AND attempt = 1`;
        const resolve = attempts.resolve({
          ownerKey: "o",
          targetHost: "c",
          payloadJson: "{}",
          now: T0,
        });
        assert.strictEqual((yield* resolve)._tag, "Pruned");
        assert.deepStrictEqual(yield* attempts.lookup("o"), {
          _tag: "Gap",
          attempt: 1,
          rerunBy: null,
        });
        assert.deepStrictEqual(yield* attempts.listPruned, [{ ownerKey: "o", attempt: 1 }]);
        // A decision for an attempt that is not the missing one changes nothing.
        assert.isFalse(
          yield* attempts.chooseRunAgain({ ownerKey: "o", attempt: 0, decidedBy: "q", now: T0 }),
        );
        assert.strictEqual((yield* resolve)._tag, "Pruned");
        assert.isTrue(
          yield* attempts.chooseRunAgain({ ownerKey: "o", attempt: 1, decidedBy: "q", now: T0 }),
        );
        assert.isFalse(
          yield* attempts.chooseRunAgain({ ownerKey: "o", attempt: 1, decidedBy: "q", now: T0 }),
        );
        assert.deepStrictEqual(yield* attempts.listPruned, []);
        const successors = yield* Effect.all([resolve, resolve], { concurrency: "unbounded" });
        assert.deepStrictEqual(successors.map((result) => result._tag).sort(), [
          "Created",
          "Resend",
        ]);
        assert.isTrue(
          successors.every((result) => ("attempt" in result ? result.attempt.attempt : null) === 2),
        );
      }).pipe(Effect.provide(Layer.provideMerge(Attempts.layer, database(freshFile())))),
  );

  it.effect(
    "cleanup visits every host in turn: a host just tried goes behind the rest even with rows left untried",
    () =>
      Effect.gen(function* () {
        const attempts = yield* Attempts.PlacementAttempts;
        const hosts = Array.from(
          { length: 21 },
          (_, index) => "h" + String(index).padStart(2, "0"),
        );
        for (const host of hosts)
          for (const n of [0, 1]) {
            const owner = host + ":" + n;
            yield* attempts.resolve({
              ownerKey: owner,
              targetHost: host,
              payloadJson: "{}",
              now: T0,
            });
            yield* attempts.recordNotStarted({ ownerKey: owner, attempt: 0, threadId: "idle" });
          }
        const first = yield* attempts.hostsWithCleanups(20);
        assert.strictEqual(first.length, 20);
        // Each visited host fails one archive and still has an untried row.
        for (const host of first) {
          const [row] = yield* attempts.nextCleanups(host, 1);
          if (row !== undefined)
            yield* attempts.markCleanupTried({ ownerKey: row.ownerKey, attempt: row.attempt });
        }
        const missed = hosts.filter((host) => !first.includes(host));
        const second = yield* attempts.hostsWithCleanups(20);
        assert.deepStrictEqual(second.slice(0, missed.length), missed);
      }).pipe(Effect.provide(Layer.provideMerge(Attempts.layer, database(freshFile())))),
  );

  it.effect(
    "cleanup visits every host in turn when archives succeed: a host with rows left after its batch goes behind the rest",
    () =>
      Effect.gen(function* () {
        const attempts = yield* Attempts.PlacementAttempts;
        const hosts = Array.from(
          { length: 21 },
          (_, index) => "h" + String(index).padStart(2, "0"),
        );
        for (const host of hosts)
          for (const n of [0, 1]) {
            const owner = host + ":" + n;
            yield* attempts.resolve({
              ownerKey: owner,
              targetHost: host,
              payloadJson: "{}",
              now: T0,
            });
            yield* attempts.recordNotStarted({ ownerKey: owner, attempt: 0, threadId: "idle" });
          }
        const first = yield* attempts.hostsWithCleanups(20);
        // Each visited host archives one batch of one row and still has a row left.
        for (const host of first) {
          const [row] = yield* attempts.nextCleanups(host, 1);
          if (row !== undefined)
            yield* attempts.clearCleanup({ ownerKey: row.ownerKey, attempt: row.attempt });
        }
        const missed = hosts.filter((host) => !first.includes(host));
        const second = yield* attempts.hostsWithCleanups(20);
        assert.deepStrictEqual(second.slice(0, missed.length), missed);
      }).pipe(Effect.provide(Layer.provideMerge(Attempts.layer, database(freshFile())))),
  );

  it.effect("the unknown list holds only undecided unknown attempts", () =>
    Effect.gen(function* () {
      const attempts = yield* Attempts.PlacementAttempts;
      yield* attempts.resolve({ ownerKey: "x", targetHost: "a", payloadJson: "{}", now: T0 });
      yield* attempts.resolve({ ownerKey: "y", targetHost: "a", payloadJson: "{}", now: T0 });
      yield* attempts.chooseRunAgain({ ownerKey: "y", attempt: 0, decidedBy: "person", now: T0 });
      assert.deepStrictEqual(
        (yield* attempts.listUnknown).map((row) => row.ownerKey),
        ["x"],
      );
    }).pipe(Effect.provide(Layer.provideMerge(Attempts.layer, database(freshFile())))),
  );
});

describe("placing on another GOAT", () => {
  it.effect(
    "a lost reply stays unknown across a restart and a target change; the same key and payload go back to the same target and a late success is that attempt's outcome",
    () => {
      const file = freshFile();
      const fake = remote();
      return Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        fake.answers.push(lost());
        const first = yield* placeOn("box-a", "Work").pipe(Effect.provide(placerOn(file, fake)));
        assert.strictEqual(first._tag, "Unknown");
        // Restart: a new placer on the same database.
        const moved = yield* placeOn("box-b", "Work").pipe(Effect.provide(placerOn(file, fake)));
        assert.strictEqual(moved._tag, "Unknown");
        assert.deepStrictEqual(
          fake.sent.map((sent) => sent.host),
          ["box-a"],
        );
        // The caller would now build another title; the frozen payload is resent.
        fake.answers.push({ ok: true, threadId: "thread-1", runId: "run-1" });
        const retried = yield* placeOn("box-a", "Changed title").pipe(
          Effect.provide(placerOn(file, fake)),
        );
        assert.deepStrictEqual(
          retried._tag === "Started"
            ? [
                retried.threadId,
                retried.runId,
                "attempt" in retried ? retried.attempt?.attempt : null,
              ]
            : retried._tag,
          ["thread-1", "run-1", 0],
        );
        assert.deepStrictEqual(
          fake.sent.map((sent) => sent.title),
          ["Work", "Work"],
        );
        assert.deepStrictEqual(fake.sent[0]?.placement, fake.sent[1]?.placement);
      });
    },
  );

  it.effect(
    "only the target's not started frees a new key; full, cordoned or expired keep the attempt",
    () => {
      const file = freshFile();
      const fake = remote();
      return Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        fake.answers.push(
          refused("placement_full"),
          refused("placement_cordoned"),
          refused("placement_expired", { mayHaveStarted: true }),
        );
        for (let index = 0; index < 3; index += 1) {
          const outcome = yield* placeOn("box-a").pipe(Effect.provide(placerOn(file, fake)));
          assert.strictEqual(outcome._tag, "Unknown");
          assert.strictEqual("attempt" in outcome ? outcome.attempt?.attempt : null, 0);
        }
        fake.answers.push(refused("placement_not_started", { threadId: "idle-thread" }));
        const fenced = yield* placeOn("box-a").pipe(Effect.provide(placerOn(file, fake)));
        assert.strictEqual(fenced._tag, "NotStarted");
        assert.deepStrictEqual(fake.archived, ["idle-thread"]);
        const next = yield* placeOn("box-b").pipe(Effect.provide(placerOn(file, fake)));
        assert.deepStrictEqual(
          [next._tag, "attempt" in next ? next.attempt?.attempt : null],
          ["Started", 1],
        );
        assert.notDeepEqual(fake.sent.at(-1)?.placement, fake.sent[0]?.placement);
      });
    },
  );

  it.effect(
    "an archive that fails is recorded and retried on the next placement to that host",
    () => {
      const file = freshFile();
      const fake = remote();
      return Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        fake.archiveFails = true;
        fake.answers.push(refused("placement_not_started", { threadId: "idle" }));
        yield* placeOn("box-a").pipe(Effect.provide(placerOn(file, fake)));
        const pending = yield* Effect.flatMap(Attempts.PlacementAttempts, (attempts) =>
          attempts.nextCleanups("box-a", 10),
        ).pipe(Effect.provide(Layer.provideMerge(Attempts.layer, database(file))));
        assert.deepStrictEqual(
          pending.map((row) => row.cleanupThreadId),
          ["idle"],
        );
        fake.archiveFails = false;
        yield* placeOn("box-a", "Work", "goal:g:a2").pipe(Effect.provide(placerOn(file, fake)));
        assert.deepStrictEqual(fake.archived, ["idle"]);
      });
    },
  );

  it.effect("Run again makes a new key only after a person's choice is recorded", () => {
    const file = freshFile();
    const fake = remote();
    return Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      fake.answers.push(lost());
      yield* placeOn("box-a").pipe(Effect.provide(placerOn(file, fake)));
      const still = yield* placeOn("box-b").pipe(Effect.provide(placerOn(file, fake)));
      assert.strictEqual(still._tag, "Unknown");
      yield* Effect.flatMap(Attempts.PlacementAttempts, (attempts) =>
        attempts.chooseRunAgain({
          ownerKey: "goal:g:a1",
          attempt: 0,
          decidedBy: "person:jun",
          now: T0,
        }),
      ).pipe(Effect.provide(Layer.provideMerge(Attempts.layer, database(file))));
      const rerun = yield* placeOn("box-b").pipe(Effect.provide(placerOn(file, fake)));
      assert.deepStrictEqual(
        [rerun._tag, "attempt" in rerun ? rerun.attempt?.attempt : null],
        ["Started", 1],
      );
      assert.deepStrictEqual(
        fake.sent.map((sent) => sent.host),
        ["box-a", "box-b"],
      );
    });
  });
});

describe("attachments of a placed launch", () => {
  it.effect(
    "a retry sends only the bytes the key was made for; changed or missing bytes send nothing, also after a restart",
    () => {
      const file = freshFile();
      const fake = remote();
      return Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const { attachment, path } = yield* Effect.gen(function* () {
          const { attachmentsDir } = yield* ServerConfig.ServerConfig;
          const attachment: ChatAttachment = {
            type: "file",
            id: ChatAttachmentId.make(createPendingAttachmentId("txt")),
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 5,
          };
          const path = resolveAttachmentPath({ attachmentsDir, attachment }) ?? "";
          NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
          NodeFS.writeFileSync(path, "first");
          return { attachment, path };
        }).pipe(Effect.provide(placerOn(file, fake)));
        const withAttachment = (ownerKey = "goal:g:files") =>
          Effect.flatMap(Placer.PlacementPlacer, (placer) =>
            placer.placeRemote({
              ownerKey,
              host: "box-a",
              launch: { ...launch(), attachments: [attachment as ChatFileAttachment] },
              authorize: Effect.succeed("full-access" as const),
            }),
          );
        fake.answers.push(lost());
        expect((yield* withAttachment().pipe(Effect.provide(placerOn(file, fake))))._tag).toBe(
          "Unknown",
        );
        NodeFS.writeFileSync(path, "other");
        const changed = yield* withAttachment().pipe(Effect.provide(placerOn(file, fake)));
        expect([changed._tag, changed._tag === "Started" ? null : changed.message]).toEqual([
          "Unknown",
          "An attachment of this placement is gone or changed here, so nothing was sent.",
        ]);
        expect(fake.sent).toHaveLength(1);
        NodeFS.writeFileSync(path, "first");
        expect((yield* withAttachment().pipe(Effect.provide(placerOn(file, fake))))._tag).toBe(
          "Started",
        );
        expect(fake.sent).toHaveLength(2);
        expect(fake.sent[0]?.placement).toEqual(fake.sent[1]?.placement);
        NodeFS.rmSync(path);
        const missing = yield* withAttachment("goal:g:other").pipe(
          Effect.provide(placerOn(file, fake)),
          Effect.flip,
        );
        expect(missing._tag).toBe("PlacementAttemptsError");
        expect(fake.sent).toHaveLength(2);
      });
    },
  );
});

describe("history and cleanup limits", () => {
  it.effect(
    "past retention an unsettled started attempt still answers from its kept row, and with that row gone the outcome reads unknown",
    () => {
      const file = freshFile();
      const fake = remote();
      return Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        fake.answers.push({ ok: true, threadId: "thread-1", runId: "run-1" });
        expect((yield* placeOn("box-a").pipe(Effect.provide(placerOn(file, fake))))._tag).toBe(
          "Started",
        );
        // The claim never settled (a crash), and the clock moved past retention before recovery.
        const store = Layer.provideMerge(Attempts.layer, database(file));
        const pruned = yield* Effect.flatMap(Attempts.PlacementAttempts, (attempts) =>
          attempts.prune(T0 + RETAIN_MS + 1),
        ).pipe(Effect.provide(store));
        expect(pruned).toBe(0);
        const again = yield* placeOn("box-b").pipe(Effect.provide(placerOn(file, fake)));
        expect(again._tag === "Started" ? again.threadId : again._tag).toBe("thread-1");
        const recover = Effect.flatMap(Placer.PlacementPlacer, (placer) =>
          placer.recover({
            ownerKey: "goal:g:a1",
            authorize: Effect.succeed("full-access" as const),
            local: () => Effect.void,
          }),
        ).pipe(Effect.provide(placerOn(file, fake)));
        expect((yield* recover)._tag).toBe("Started");
        // However the row went, a missing latest attempt answers nothing and frees nothing.
        yield* Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql`DELETE FROM placement_attempts`,
        ).pipe(Effect.provide(store));
        expect((yield* placeOn("box-b").pipe(Effect.provide(placerOn(file, fake))))._tag).toBe(
          "Unknown",
        );
        expect((yield* recover)._tag).toBe("Unknown");
        expect(fake.sent).toHaveLength(1);
      });
    },
  );

  it.effect("permanently failing archives do not starve the others on that host", () => {
    const file = freshFile();
    const fake = remote();
    return Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      yield* Effect.gen(function* () {
        const attempts = yield* Attempts.PlacementAttempts;
        for (let index = 0; index < 25; index += 1) {
          const owner = "goal:g:idle-" + index;
          yield* attempts.resolve({
            ownerKey: owner,
            targetHost: "box-a",
            payloadJson: "{}",
            now: T0 + index,
          });
          yield* attempts.recordNotStarted({
            ownerKey: owner,
            attempt: 0,
            threadId: "idle-" + index,
          });
          if (index < 20) fake.archiveFailsFor.add("idle-" + index);
        }
      }).pipe(Effect.provide(Layer.provideMerge(Attempts.layer, database(file))));
      yield* placeOn("box-a", "Work", "goal:g:n1").pipe(Effect.provide(placerOn(file, fake)));
      yield* placeOn("box-a", "Work", "goal:g:n2").pipe(Effect.provide(placerOn(file, fake)));
      expect(fake.archived.toSorted()).toEqual([
        "idle-20",
        "idle-21",
        "idle-22",
        "idle-23",
        "idle-24",
      ]);
    });
  });
});
