import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2ProviderTurn,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { makePiAdapterV2, PI_PROVIDER } from "./adapter.ts";
import { makeFakePi, makeFakePiWithResponses, recordedIdleState } from "./test/fakePi.ts";

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

const time = (seconds: number) => DateTime.makeUnsafe(seconds * 1000);
const entry = (
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  seconds: number,
) => ({
  type: "message",
  id,
  parentId,
  timestamp: DateTime.formatIso(time(seconds)),
  message: { role, content: [] },
});
const ref = (nativeId: string, strength: "strong" | "weak" = "strong") => ({
  driver: PI_PROVIDER,
  nativeId,
  strength,
});
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      type: Schema.String,
      entryId: Schema.optional(Schema.String),
      sessionPath: Schema.optional(Schema.String),
    }),
  ),
);

it.effect.each([
  "earlier checkpoint",
  "last checkpoint",
  "uncaptured handoff",
  "command-only handoff",
  "legacy turns",
  "checkpoint inherited by a prior fork",
  "repeated rollback after a handoff",
  "handoff prompt left in the source",
  "a checkpoint recorded before upgrading, followed by a session switch",
  "switch timed out after attaching",
] as const)("restores exactly the retained Pi history for %s", (scenario) =>
  Effect.gen(function* () {
    const repro =
      scenario === "a checkpoint recorded before upgrading, followed by a session switch";
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const oldFile = `${dir}/old.jsonl`;
    const currentFile = `${dir}/current.jsonl`;
    const previousForkFile = `${dir}/previous-fork.jsonl`;
    const forkedFile = `${dir}/forked.jsonl`;
    const oldEntries = [
      entry("u1", null, "user", 10),
      entry("a1", "u1", "assistant", 15),
      entry("u2", "a1", "user", 30),
      entry("steer", "u2", "user", 33),
      entry("a2", "steer", "assistant", 35),
    ];
    const inherited = scenario === "checkpoint inherited by a prior fork";
    const handoffEntry = entry("u3", inherited ? "a2" : null, "user", 50);
    const newEntries =
      scenario === "command-only handoff"
        ? []
        : inherited
          ? [...oldEntries, handoffEntry]
          : [handoffEntry];
    const repeated = scenario === "repeated rollback after a handoff";
    const oldSuffix = repeated || scenario === "handoff prompt left in the source";
    const sessions = new Map([
      [oldFile, oldSuffix ? [...oldEntries, entry("discarded", "a2", "user", 45)] : oldEntries],
      [currentFile, newEntries],
    ]);
    if (repeated) sessions.set(previousForkFile, [...oldEntries, entry("u3", "a2", "user", 50)]);
    for (const [file, entries] of sessions) {
      yield* fs.writeFileString(
        file,
        [{ type: "session", version: 3, cwd: process.cwd() }, ...entries]
          .map((item) => JSON.stringify(item))
          .join("\n") + "\n",
      );
    }

    const output = yield* Queue.unbounded<Uint8Array>();
    const switchApplied = yield* Deferred.make<void>();
    const sessionRequests: { readonly type: string; readonly file: string }[] = [];
    let liveFile = currentFile;
    let pending = "";
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const stdin = Sink.forEach((chunk: Uint8Array) =>
      Effect.gen(function* () {
        const lines = (pending + decoder.decode(chunk, { stream: true })).split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const request = decodeRequest(line);
          const entries = sessions.get(liveFile) ?? [];
          let data: unknown = {};
          let error: string | undefined;
          if (request.type === "get_state") data = { sessionFile: liveFile };
          if (request.type === "get_entries")
            data = { entries, leafId: entries.at(-1)?.id ?? null };
          if (request.type === "switch_session") {
            if (request.sessionPath !== undefined && sessions.has(request.sessionPath)) {
              liveFile = request.sessionPath;
              sessionRequests.push({ type: "switch_session", file: liveFile });
              if (scenario === "switch timed out after attaching") {
                yield* Deferred.succeed(switchApplied, undefined);
                continue;
              }
              data = { cancelled: false };
            } else error = "Session not found";
          }
          if (request.type === "fork") {
            const index = entries.findIndex(({ id }) => id === request.entryId);
            if (index === -1) error = "Invalid entry ID for forking";
            else {
              sessionRequests.push({ type: "fork", file: liveFile });
              sessions.set(forkedFile, entries.slice(0, index));
              liveFile = forkedFile;
              data = { cancelled: false };
            }
          }
          yield* Queue.offer(
            output,
            encoder.encode(
              JSON.stringify({
                type: "response",
                id: request.id,
                command: request.type,
                success: error === undefined,
                data,
                error,
              }) + "\n",
            ),
          );
        }
      }),
    );
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(999_999_999),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin,
          stdout: Stream.fromQueue(output),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    );
    const instanceId = ProviderInstanceId.make("pi");
    const adapter = yield* makePiAdapterV2({
      instanceId,
      settings: { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      environment: {},
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    const threadId = ThreadId.make("pi-rollback");
    const modelSelection = { instanceId, model: "default" };
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: process.cwd(),
    });
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("pi-rollback"),
      modelSelection,
      runtimePolicy,
    });
    const events = yield* runtime.events.pipe(Stream.runDrain, Effect.result, Effect.forkScoped);
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    const turns = (repeated ? [1, 2, 3, 4] : [1, 2, 3]).map(
      (ordinal): OrchestrationV2ProviderTurn => ({
        id: ProviderTurnId.make(`turn-${ordinal}`),
        providerThreadId: providerThread.id,
        nodeId: NodeId.make(`node-${ordinal}`),
        runAttemptId: null,
        nativeTurnRef:
          ordinal === 3 && scenario === "command-only handoff"
            ? null
            : ordinal === 3 && (scenario === "uncaptured handoff" || repro)
              ? ref("uncaptured", "weak")
              : ref(`u${ordinal}`),
        ...(scenario === "legacy turns" || (repro && ordinal < 3)
          ? {}
          : {
              nativeThreadRef: ref(
                ordinal < 3 ? oldFile : ordinal === 3 && repeated ? previousForkFile : currentFile,
              ),
            }),
        ordinal,
        status: "completed",
        startedAt: time(ordinal * 20 - 10),
        completedAt: time(ordinal * 20),
      }),
    );
    const shouldFork = scenario === "earlier checkpoint" || scenario === "legacy turns";
    const target = turns[shouldFork ? 0 : 1];
    if (target === undefined) return assert.fail("missing target turn");
    const rollback = runtime.rollbackThread({
      providerThread,
      target: {
        type: "provider_turn",
        checkpointId: CheckpointId.make("checkpoint"),
        appRunOrdinal: target.ordinal,
        providerTurn: target,
      },
      providerThreadTurns: turns,
    });
    if (scenario === "switch timed out after attaching") {
      const attempt = yield* rollback.pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(switchApplied);
      assert.equal(liveFile, oldFile);
      yield* TestClock.adjust("61 seconds");
      assert.equal((yield* Fiber.join(attempt))._tag, "Failure");
      yield* Fiber.join(events);
      assert.include(["error", "stopped"], runtime.providerSession.status);
      assert.deepEqual(sessionRequests, [{ type: "switch_session", file: oldFile }]);
      return;
    }
    if (repro) {
      const restored = yield* rollback.pipe(Effect.result);
      assert.equal(restored._tag, "Success");
      assert.deepEqual(
        sessions.get(liveFile)?.map(({ id }) => id),
        ["u1", "a1", "u2", "steer", "a2"],
      );
      return;
    }
    const restored = yield* rollback;
    assert.equal(
      restored.providerThread.nativeThreadRef?.nativeId,
      shouldFork || inherited || oldSuffix ? forkedFile : oldFile,
    );
    assert.equal(
      restored.providerThread.nativeConversationHeadRef?.nativeId,
      shouldFork ? "a1" : "a2",
    );
    assert.deepEqual(
      sessions.get(liveFile)?.map(({ id }) => id),
      shouldFork ? ["u1", "a1"] : ["u1", "a1", "u2", "steer", "a2"],
    );
    assert.deepEqual(
      sessionRequests,
      inherited
        ? [{ type: "fork", file: currentFile }]
        : [
            { type: "switch_session", file: repeated ? previousForkFile : oldFile },
            ...(shouldFork || oldSuffix
              ? [{ type: "fork", file: repeated ? previousForkFile : oldFile }]
              : []),
          ],
    );
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const TURN_ONE_ENTRIES = [
  entry("u1", null, "user", 10),
  entry("a1", "u1", "assistant", 20),
  entry("steer1", "a1", "user", 30),
  entry("a1b", "steer1", "assistant", 40),
];

it.effect.each([
  "captured handoff",
  "command-only handoff",
  "legacy uncaptured boundary",
  "adopted prompt",
  "retry after creating a recovery fork",
  "label before the discarded prompt",
  "conflicting prior fork",
  "captured boundary on a sibling branch",
  "dangling checkpoint parent",
  "different branch attached after recovery",
] as const)("restores a legacy checkpoint after a %s", (scenario) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const original = `${dir}/z-original.jsonl`;
    const switched = `${dir}/current.jsonl`;
    const priorFork = `${dir}/fork.jsonl`;
    const retained = TURN_ONE_ENTRIES;
    const labelled = scenario === "label before the discarded prompt";
    const retry = labelled || scenario === "retry after creating a recovery fork";
    const conflicting = scenario === "conflicting prior fork";
    const sibling = scenario === "captured boundary on a sibling branch";
    const changedBranch = scenario === "different branch attached after recovery";
    const handoff = entry(
      "u3",
      sibling || scenario === "dangling checkpoint parent" ? "a1b" : null,
      "user",
      180,
    );
    type Entry = { readonly id: string; readonly parentId: string | null; readonly type: string };
    const sessions = new Map<string, ReadonlyArray<Entry>>();
    const write = (file: string, entries: ReadonlyArray<Entry>) =>
      fs
        .writeFileString(
          file,
          [{ type: "session", version: 3 }, ...entries]
            .map((item) => encodeJsonLine(item))
            .join("\n") + "\n",
        )
        .pipe(Effect.tap(() => Effect.sync(() => sessions.set(file, entries))));
    const extra = entry("other", "a1b", "assistant", 45);
    const discarded = entry("discarded", labelled ? "label" : "a1b", "user", 160);
    const label = { type: "label", id: "label", parentId: "a1b", targetId: "a1", label: "keep" };
    yield* write(
      original,
      changedBranch
        ? [...retained, extra, discarded]
        : retry
          ? [...retained, ...(labelled ? [label] : []), discarded]
          : retained,
    );
    yield* write(
      switched,
      sibling
        ? [...retained, handoff, entry("sibling", null, "assistant", 28)]
        : scenario === "dangling checkpoint parent"
          ? [...retained.slice(1), handoff]
          : [handoff],
    );
    if (conflicting) yield* write(priorFork, [...retained, extra]);

    let liveFile = switched;
    const fake = yield* makeFakePiWithResponses((request, response) =>
      Effect.gen(function* () {
        const entries = sessions.get(liveFile) ?? [];
        switch (request["type"]) {
          case "get_state":
            return { ...response, data: recordedIdleState(liveFile) };
          case "get_entries":
            return {
              ...response,
              data: {
                entries,
                leafId:
                  changedBranch && liveFile === original ? "other" : (entries.at(-1)?.id ?? null),
              },
            };
          case "switch_session": {
            const file = request["sessionPath"];
            if (typeof file !== "string" || !sessions.has(file))
              throw new Error("Pi switch requested an unknown fixture session");
            liveFile = file;
            return response;
          }
          case "fork": {
            let parentId = entries.find(({ id }) => id === request["entryId"])?.parentId;
            assert.isDefined(parentId);
            const pathEntries: Array<Entry> = [];
            while (parentId != null) {
              const found = entries.find(({ id }) => id === parentId);
              assert.isDefined(found);
              if (found === undefined) break;
              pathEntries.unshift(found);
              parentId = found.parentId;
            }
            // Like Pi, drop labels from the path and re-add them with new ids at the leaf.
            const branch: Array<Entry> = [];
            for (const item of pathEntries.filter(({ type }) => type !== "label"))
              branch.push({ ...item, parentId: branch.at(-1)?.id ?? null });
            for (const item of pathEntries.filter(({ type }) => type === "label"))
              branch.push({
                ...item,
                id: `${item.id}-copy`,
                parentId: branch.at(-1)?.id ?? null,
              });
            yield* write(priorFork, branch).pipe(Effect.orDie);
            liveFile = priorFork;
            return response;
          }
          default:
            return response;
        }
      }),
    );
    const instanceId = ProviderInstanceId.make("pi");
    const adapter = yield* makePiAdapterV2({
      instanceId,
      settings: { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      environment: {},
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));
    const threadId = ThreadId.make("pi-legacy-rollback");
    const modelSelection = { instanceId, model: "default" };
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: process.cwd(),
    });
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("pi-legacy-rollback"),
      modelSelection,
      runtimePolicy,
    });
    yield* runtime.events.pipe(Stream.runDrain, Effect.forkScoped);
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    const target: OrchestrationV2ProviderTurn = {
      id: ProviderTurnId.make("turn-1"),
      providerThreadId: providerThread.id,
      nodeId: NodeId.make("node-1"),
      runAttemptId: null,
      nativeTurnRef: ref("u1"),
      ordinal: 1,
      status: "completed",
      startedAt: time(scenario === "adopted prompt" ? 20 : 0),
      completedAt: time(50),
    };
    const boundary: OrchestrationV2ProviderTurn = {
      id: ProviderTurnId.make("turn-2"),
      providerThreadId: providerThread.id,
      nodeId: NodeId.make("node-2"),
      runAttemptId: null,
      nativeTurnRef:
        scenario === "command-only handoff"
          ? null
          : scenario === "legacy uncaptured boundary"
            ? ref("synthetic-2", "weak")
            : ref("u3"),
      ...(scenario === "legacy uncaptured boundary" ? {} : { nativeThreadRef: ref(switched) }),
      ordinal: 2,
      status: "cancelled",
      startedAt: time(150),
      completedAt: time(200),
    };
    const rewind = runtime.rollbackThread({
      providerThread: { ...providerThread, createdAt: time(0) },
      target: {
        type: "provider_turn",
        checkpointId: CheckpointId.make("legacy-checkpoint"),
        appRunOrdinal: target.ordinal,
        providerTurn: target,
      },
      providerThreadTurns: [target, boundary],
    });
    const requests = () =>
      fake.allRequests().flatMap((request) => {
        if (request["type"] === "switch_session")
          return [{ type: request["type"], value: request["sessionPath"] }];
        if (request["type"] === "fork")
          return [{ type: request["type"], value: request["entryId"] }];
        return [];
      });
    if (conflicting || changedBranch) {
      assert.equal((yield* rewind.pipe(Effect.result))._tag, "Failure");
      assert.deepEqual(
        requests(),
        changedBranch ? [{ type: "switch_session", value: original }] : [],
      );
      return;
    }
    const expected = retry || sibling ? priorFork : original;
    const assertRestored = ({ providerThread: restored }: Effect.Success<typeof rewind>) => {
      assert.equal(restored.nativeThreadRef?.nativeId, expected);
      assert.equal(restored.nativeConversationHeadRef?.nativeId, labelled ? "label-copy" : "a1b");
      assert.equal(liveFile, expected);
      assert.deepEqual(
        sessions.get(liveFile)?.filter(({ type }) => type !== "label"),
        retained,
      );
    };
    const expectedRequests = [
      ...(sibling ? [] : [{ type: "switch_session", value: original }]),
      ...(retry || sibling ? [{ type: "fork", value: sibling ? "u3" : "discarded" }] : []),
    ];
    assertRestored(yield* rewind);
    assert.deepEqual(requests(), expectedRequests);
    if (retry) {
      assertRestored(yield* rewind);
      assert.deepEqual(requests(), expectedRequests);
    }
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect.each([
  {
    checkpoint: "strong",
    ordinal: 2,
    handoff: "command",
    returnedPrompt: false,
    discarded: true,
  },
  { checkpoint: "strong", ordinal: 2, handoff: "prompt", returnedPrompt: true, discarded: true },
  {
    checkpoint: "command",
    ordinal: 2,
    handoff: "prompt",
    returnedPrompt: false,
    discarded: false,
  },
  { checkpoint: "weak", ordinal: 2, handoff: "prompt", returnedPrompt: false, discarded: false },
  {
    checkpoint: "command",
    ordinal: 1,
    handoff: "prompt",
    returnedPrompt: false,
    discarded: false,
  },
  { checkpoint: "weak", ordinal: 1, handoff: "prompt", returnedPrompt: true, discarded: true },
] as const)("restores the Pi checkpoint after a session round trip %j", (scenario) =>
  Effect.gen(function* () {
    const fake = yield* makeFakePi;
    const instanceId = ProviderInstanceId.make("pi");
    const adapter = yield* makePiAdapterV2({
      instanceId,
      settings: { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      environment: {},
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));
    const threadId = ThreadId.make("pi-roundtrip-rollback");
    const modelSelection = { instanceId, model: "default" };
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: process.cwd(),
    });
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("pi-roundtrip-rollback"),
      modelSelection,
      runtimePolicy,
    });
    yield* runtime.events.pipe(Stream.runDrain, Effect.forkScoped);
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    const sessionFile = providerThread.nativeThreadRef?.nativeId;
    if (sessionFile == null) return assert.fail("missing sessionFile");
    const forkFile = "/fake/rewound.jsonl";
    const turn = (
      ordinal: number,
      nativeTurnRef: OrchestrationV2ProviderTurn["nativeTurnRef"],
      file = sessionFile,
    ): OrchestrationV2ProviderTurn => ({
      id: ProviderTurnId.make(`turn-${ordinal}`),
      providerThreadId: providerThread.id,
      nodeId: NodeId.make(`node-${ordinal}`),
      runAttemptId: null,
      nativeTurnRef,
      nativeThreadRef: ref(file),
      ordinal,
      status: "completed",
      startedAt: time(ordinal * 50 - 50),
      completedAt: time(ordinal * 50),
    });
    const target = turn(
      scenario.ordinal,
      scenario.checkpoint === "strong"
        ? ref("u2")
        : scenario.checkpoint === "weak"
          ? ref("uncaptured", "weak")
          : null,
    );
    const retained =
      scenario.ordinal === 1 || scenario.checkpoint === "command"
        ? TURN_ONE_ENTRIES
        : [...TURN_ONE_ENTRIES, entry("u2", "a1b", "user", 60), entry("a2", "u2", "assistant", 80)];
    const retainedHead = retained.at(-1)?.id;
    if (retainedHead === undefined) return assert.fail("missing retainedHead");
    const entries = [
      ...retained,
      ...(scenario.discarded
        ? [
            entry("discarded", retainedHead, "user", 110),
            entry("discarded-answer", "discarded", "assistant", 120),
          ]
        : []),
      ...(scenario.returnedPrompt ? [entry("u5", "discarded-answer", "user", 210)] : []),
    ];
    fake.setSessionEntries(entries, forkFile);
    const restored = yield* runtime.rollbackThread({
      providerThread,
      target: {
        type: "provider_turn",
        checkpointId: CheckpointId.make("checkpoint-1"),
        appRunOrdinal: target.ordinal,
        providerTurn: target,
      },
      providerThreadTurns: [
        ...(target.ordinal === 2 ? [turn(1, ref("u1"))] : []),
        target,
        turn(
          target.ordinal + 1,
          scenario.handoff === "prompt" ? ref("away") : null,
          "/fake/other.jsonl",
        ),
        turn(target.ordinal + 2, null, "/fake/clone.jsonl"),
        turn(target.ordinal + 3, null),
        ...(scenario.returnedPrompt ? [turn(target.ordinal + 4, ref("u5"))] : []),
      ],
    });
    const requests = fake.allRequests();
    assert.isFalse(requests.some((request) => request["type"] === "switch_session"));
    assert.deepEqual(
      requests.filter((request) => request["type"] === "fork").map((request) => request["entryId"]),
      scenario.discarded ? ["discarded"] : [],
    );
    assert.equal(
      restored.providerThread.nativeThreadRef?.nativeId,
      scenario.discarded ? forkFile : sessionFile,
    );
    assert.equal(restored.providerThread.nativeConversationHeadRef?.nativeId, retainedHead);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
