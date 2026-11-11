// @effect-diagnostics nodeBuiltinImport:off - each test gets a scratch database and attachment folder.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  type ChatAttachment,
  type CommandId,
  OrchestratorMcpFailure,
  ProjectId,
  type ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { PenServiceCaller } from "@goat/pen-protocol/service";

import { createPendingAttachmentId, resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import type * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import { makeHarness } from "../../orchestration-v2/testkit/ThreadLaunchHarness.ts";
import {
  launchInput,
  modelSelection,
  projectId,
} from "../../orchestration-v2/testkit/threadLaunchInput.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as FleetHostStates from "../health/FleetHostStates.ts";
import * as Admission from "./PlacementAdmission.ts";
import { PlacementAdmissionEnabled } from "./PlacementKey.ts";
import * as PlacementLaunch from "./PlacementLaunch.ts";
import * as Reservations from "./PlacementReservations.ts";

const T0 = Date.UTC(2026, 10, 1);
const member = (nodeId: string): PenServiceCaller => ({
  nodeId,
  signPub: "s".repeat(43),
  noisePub: "n".repeat(43),
  name: nodeId,
});
const isoAt = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const ISSUED = isoAt(T0);

const targetLayer = (enabled = true) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "placement-launch-"));
  const harness = makeHarness({
    runSetup: () => Effect.never,
    databaseLayer: Layer.orDie(
      SqlitePersistence.layerFromPath(NodePath.join(dir, "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  });
  return PlacementLaunch.layer.pipe(
    Layer.provideMerge(Admission.layer),
    Layer.provideMerge(Layer.mergeAll(Reservations.layer, FleetHostStates.layer)),
    Layer.provideMerge(harness.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(dir, { prefix: "placement-launch-config-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(Layer.succeed(PlacementAdmissionEnabled, enabled)),
  );
};

const client = (overrides: Partial<McpInvocationContext.McpClientCaller> = {}) =>
  ({
    client: { sessionId: "session-1", label: "SSH dispatch", access: "full-access", ...overrides },
    thread: undefined,
  }) as unknown as McpInvocationContext.McpInvocationScope;

const params = (overrides: Record<string, unknown> = {}) =>
  ({
    title: "Placed",
    projectId,
    message: "do the work",
    interactionMode: "default",
    placement: { ownerKey: "goal:g1:a1", attempt: 0, issuedAt: ISSUED },
    ...overrides,
  }) as Parameters<PlacementLaunch.PlacementTargetShape["launch"]>[1];

/** The ordinary launch with the placement's command id, shaped like the tool's success. */
const runner = Effect.gen(function* () {
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const calls = yield* Ref.make<ReadonlyArray<CommandId>>([]);
  const run = (commandId: CommandId) =>
    Ref.update(calls, (all) => [...all, commandId]).pipe(
      Effect.andThen(
        launches.launch(
          launchInput({ command: commandId, thread: commandId, message: "go " + commandId }),
        ),
      ),
      Effect.map((launched) => ({
        threadId: launched.threadId,
        projectId: ProjectId.make(projectId),
        modelSelection,
        runId: launched.projection.runs[0]?.id ?? null,
        status: launched.projection.runs[0]?.status ?? null,
        watching: true,
        standingInstructionsVersion: null,
      })),
      Effect.mapError(
        (cause) =>
          new OrchestratorMcpFailure({ code: "orchestration_error", message: String(cause) }),
      ),
    );
  return { calls, run };
});

const failureOf = (
  scope: McpInvocationContext.McpInvocationScope,
  input: Parameters<PlacementLaunch.PlacementTargetShape["launch"]>[1],
  run: (commandId: CommandId) => Effect.Effect<unknown, unknown>,
) => PlacementLaunch.launchPlaced(scope, input, run as never).pipe(Effect.flip);

const pendingAttachment = (
  bytes: string,
  name = "notes.txt",
): Effect.Effect<ChatAttachment, never, ServerConfig.ServerConfig> =>
  Effect.gen(function* () {
    const { attachmentsDir } = yield* ServerConfig.ServerConfig;
    const attachment: ChatAttachment = {
      type: "file",
      id: ChatAttachmentId.make(createPendingAttachmentId("txt")),
      name,
      mimeType: "text/plain",
      sizeBytes: Buffer.byteLength(bytes),
    };
    const path = resolveAttachmentPath({ attachmentsDir, attachment });
    if (path === null) return yield* Effect.die("no attachment path");
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, bytes);
    return attachment;
  });

describe("goat_thread_launch with placement on the target", () => {
  it.effect(
    "an admitted placement answers started with the launch's own result, and a retry answers started from the thread",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const { calls, run } = yield* runner;
        const first = yield* PlacementLaunch.launchPlaced(client(), params(), run);
        assert.deepStrictEqual(first.placement, { outcome: "started" });
        assert.isTrue(first.watching);
        const retry = yield* PlacementLaunch.launchPlaced(client(), params(), run);
        assert.deepStrictEqual(
          [retry.threadId, retry.runId, retry.placement, retry.watching],
          [first.threadId, first.runId, { outcome: "started" }, false],
        );
        assert.strictEqual((yield* Ref.get(calls)).length, 1);
      }).pipe(Effect.provide(targetLayer())),
  );

  it.effect(
    "a request refused as invalid answers from its key: a started key reads conflicting and may have started, a key never seen is a definite refusal",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const { calls, run } = yield* runner;
        yield* PlacementLaunch.launchPlaced(client(), params(), run);
        for (const change of [
          { message: undefined },
          { message: "  " },
          { references: [{ kind: "thread", threadId: "thread-x" }] },
        ]) {
          const failure = yield* failureOf(client(), params(change), run);
          assert.deepStrictEqual(
            [failure.classification, failure.mayHaveStarted],
            ["placement_conflicting", true],
            JSON.stringify(change),
          );
        }
        const unseen = yield* failureOf(
          client(),
          params({
            message: undefined,
            placement: { ownerKey: "goal:g1:other", attempt: 0, issuedAt: ISSUED },
          }),
          run,
        );
        assert.deepStrictEqual(
          [unseen.classification, unseen.mayHaveStarted],
          ["placement_no_message", false],
        );
        assert.strictEqual((yield* Ref.get(calls)).length, 1);
      }).pipe(Effect.provide(targetLayer())),
  );

  it.effect(
    "the same key with a changed message, memory grant ceiling, interaction mode or report setting is conflicting; an identical retry joins",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const { calls, run } = yield* runner;
        yield* PlacementLaunch.launchPlaced(client(), params(), run);
        for (const change of [
          { message: "other work" },
          { memoryGrantCeiling: "read" },
          { interactionMode: "plan" },
          { report: { correlationId: "c-1", originEnvironmentId: "env", originThreadId: "t" } },
          { notifyOnCompletion: false },
        ]) {
          const failure = yield* failureOf(client(), params(change), run);
          assert.strictEqual(
            failure.classification,
            "placement_conflicting",
            JSON.stringify(change),
          );
          assert.isTrue(failure.mayHaveStarted);
        }
        // Another runtime ceiling on the session is another principal.
        const ceiling = yield* failureOf(client({ access: "auto" }), params(), run);
        assert.strictEqual(ceiling.classification, "placement_conflicting");
        const again = yield* PlacementLaunch.launchPlaced(client(), params(), run);
        assert.deepStrictEqual(again.placement, { outcome: "started" });
        assert.strictEqual((yield* Ref.get(calls)).length, 1);
      }).pipe(Effect.provide(targetLayer())),
  );

  it.effect(
    "attachments count by content: a re-upload under a new id joins, changed bytes conflict, and missing bytes are refused as unavailable",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const { calls, run } = yield* runner;
        const first = yield* pendingAttachment("same bytes");
        yield* PlacementLaunch.launchPlaced(client(), params({ attachments: [first] }), run);
        const reuploaded = yield* pendingAttachment("same bytes");
        const joined = yield* PlacementLaunch.launchPlaced(
          client(),
          params({ attachments: [reuploaded] }),
          run,
        );
        assert.deepStrictEqual(joined.placement, { outcome: "started" });
        const changed = yield* pendingAttachment("other bytes");
        const conflict = yield* failureOf(client(), params({ attachments: [changed] }), run);
        assert.strictEqual(conflict.classification, "placement_conflicting");
        const missing = {
          ...reuploaded,
          id: ChatAttachmentId.make(createPendingAttachmentId("txt")),
        };
        const unavailable = yield* failureOf(client(), params({ attachments: [missing] }), run);
        assert.strictEqual(unavailable.classification, "placement_attachment_unavailable");
        assert.isTrue(unavailable.mayHaveStarted);
        assert.strictEqual((yield* Ref.get(calls)).length, 1);
      }).pipe(Effect.provide(targetLayer())),
  );

  it.effect(
    "a stored attachment that grew past its declared size is refused as unavailable and launches nothing",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const { calls, run } = yield* runner;
        const { attachmentsDir } = yield* ServerConfig.ServerConfig;
        const attachment = yield* pendingAttachment("tiny");
        const path = resolveAttachmentPath({ attachmentsDir, attachment });
        if (path === null) return yield* Effect.die("no attachment path");
        NodeFS.writeFileSync(path, "tiny".repeat(4096));
        const refused = yield* failureOf(client(), params({ attachments: [attachment] }), run);
        assert.strictEqual(refused.classification, "placement_attachment_unavailable");
        assert.strictEqual((yield* Ref.get(calls)).length, 0);
      }).pipe(Effect.provide(targetLayer())),
  );

  it.effect("a field the caller adds, such as its own hash, is not part of the digest", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const { calls, run } = yield* runner;
      yield* PlacementLaunch.launchPlaced(client(), params({ digest: "aaaa" }), run);
      const again = yield* PlacementLaunch.launchPlaced(client(), params({ digest: "bbbb" }), run);
      assert.deepStrictEqual(again.placement, { outcome: "started" });
      assert.strictEqual((yield* Ref.get(calls)).length, 1);
    }).pipe(Effect.provide(targetLayer())),
  );

  it.effect("a key more than 25 days old is refused as expired, with its outcome unknown", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const { calls, run } = yield* runner;
      const old = isoAt(T0 - Reservations.ADMIT_WINDOW_MS - 1);
      const failure = yield* failureOf(
        client(),
        params({ placement: { ownerKey: "goal:g1:a1", attempt: 0, issuedAt: old } }),
        run,
      );
      assert.strictEqual(failure.classification, "placement_expired");
      assert.isTrue(failure.mayHaveStarted);
      assert.strictEqual((yield* Ref.get(calls)).length, 0);
    }).pipe(Effect.provide(targetLayer())),
  );

  it.effect(
    "placers keep their own keyspace: the same owner key from two Pen members is two placements",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const { calls, run } = yield* runner;
        const a = yield* PlacementLaunch.launchPlaced(
          client({ pen: member("node-a") }),
          params(),
          run,
        );
        const b = yield* PlacementLaunch.launchPlaced(
          client({ pen: member("node-b") }),
          params(),
          run,
        );
        assert.notStrictEqual(a.threadId, b.threadId);
        assert.strictEqual((yield* Ref.get(calls)).length, 2);
        assert.strictEqual(PlacementLaunch.placerOf(client()), "local");
        assert.strictEqual(
          PlacementLaunch.placerOf(client({ pen: member("node-a") })),
          "pen:node-a",
        );
      }).pipe(Effect.provide(targetLayer())),
  );

  it.effect("refusals before admission: no message, a bad issuedAt, a thread caller", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const { calls, run } = yield* runner;
      const noMessage = yield* failureOf(client(), params({ message: undefined }), run);
      assert.strictEqual(noMessage.classification, "placement_no_message");
      const badTime = yield* failureOf(
        client(),
        params({ placement: { ownerKey: "k", attempt: 0, issuedAt: "yesterday" } }),
        run,
      );
      assert.strictEqual(badTime.classification, "placement_invalid");
      const threadCaller = {
        client: undefined,
        thread: { threadId: "thread:caller" as ThreadId },
      } as unknown as McpInvocationContext.McpInvocationScope;
      const fromThread = yield* failureOf(threadCaller, params(), run);
      assert.strictEqual(fromThread.classification, "placement_invalid");
      assert.isFalse(noMessage.mayHaveStarted);
      assert.strictEqual((yield* Ref.get(calls)).length, 0);
    }).pipe(Effect.provide(targetLayer())),
  );
});

describe("placement switched off", () => {
  it.effect("with the switch off a placement is refused before anything runs", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const { calls, run } = yield* runner;
      const failure = yield* failureOf(client(), params(), run);
      assert.strictEqual(failure.classification, "placement_off");
      assert.isFalse(failure.mayHaveStarted);
      assert.strictEqual((yield* Ref.get(calls)).length, 0);
    }).pipe(Effect.provide(targetLayer(false))),
  );

  it.effect("without the placement service in context a placement is refused as off", () =>
    Effect.gen(function* () {
      const failure = yield* PlacementLaunch.launchPlaced(client(), params(), () =>
        Effect.die("must not launch"),
      ).pipe(Effect.flip);
      assert.strictEqual(failure.classification, "placement_off");
    }),
  );
});
