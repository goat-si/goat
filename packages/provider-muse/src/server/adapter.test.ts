// @effect-diagnostics-next-line nodeBuiltinImport:off -- Mock native realpath to exercise macOS case correction on every platform.
import * as NodeFSP from "node:fs/promises";
import { vi } from "vite-plus/test";
import { assert, describe, it } from "@effect/vitest";
import { MspError } from "@muse-code/sdk";
import {
  MUSE_DEFAULT_MODEL,
  EnvironmentId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { AgentScope } from "@goat/shared/AgentScope";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import type { MuseItem, MuseSubscriptionUsage } from "./protocol.ts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import { makeMuseAdapterV2 } from "./adapter.ts";

import {
  testLayer,
  MUSE_PROVIDER,
  INSTANCE_ID,
  THREAD_ID,
  MODEL,
  museSettings,
  runtimePolicy,
  modelSelection,
  pendingPromise,
  makeFakeMuse,
  makeHarness,
  preallocatedProviderThread,
  turnInput,
  startConversation,
} from "./test/adapterHelpers.ts";
const SUBSCRIPTION_USAGE = {
  window: { usedPercent: 0, windowDurationMins: 300, resetsAtMs: 1791465557000 },
  weekly: { usedPercent: 5, resetsAtMs: 1791763200000 },
  tier: "tier-1",
  observedAtMs: 1791447762610,
} satisfies MuseSubscriptionUsage;
const QUOTA_MESSAGE =
  "API error 429: Subscription quota exhausted. Your usage window resets soon. (rate_limit_error)";
const RELAYED_QUOTA_MESSAGE =
  "API error 429: All credentials for model muse-wonder-1.0-contributor are cooling down (last error: rate_limit_exceeded: Subscription quota exhausted. Your usage window resets at 2026-10-13T10:45:52Z.) (after 10 provider attempts)";

const approval = (turnId: string) => ({
  approvalId: "approval-1",
  turnId,
  currentRequirementId: { approvalId: "approval-1", sourceIndex: 0 },
  availableChoices: [
    { choiceId: "once", label: "Allow once", decision: "approved", scope: "once" },
    { choiceId: "deny", label: "Deny", decision: "denied", scope: "once" },
  ],
  subject: { kind: "shell", command: "touch result.txt" },
});

vi.mock("node:fs/promises", { spy: true });

describe("MuseAdapterV2", () => {
  it.effect.each([true, false])(
    "forceNewNativeThread starts a distinct session preserving row identity with existing row %s",
    (includeExisting) =>
      Effect.gen(function* () {
        const fake = yield* makeFakeMuse();
        const harness = yield* makeHarness(fake, INSTANCE_ID, "saved-session");
        const original = harness.providerThread;
        const fresh = yield* harness.runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection(),
          runtimePolicy,
          ...(includeExisting ? { existingProviderThread: original } : {}),
          forceNewNativeThread: true,
        });
        assert.notStrictEqual(fresh.nativeThreadRef?.nativeId, original.nativeThreadRef?.nativeId);
        assert.strictEqual(fresh.id, original.id);
        assert.strictEqual(fresh.createdAt, original.createdAt);
        assert.strictEqual(fresh.appThreadId, original.appThreadId);
        assert.strictEqual(fresh.providerSessionId, original.providerSessionId);
        assert.strictEqual(fresh.status, "idle");
        const starts = fake.calls.filter((call) => call.method === "session/start");
        assert.strictEqual(starts.length, 1);
        assert.strictEqual(starts[0]?.params.sessionId, fresh.nativeThreadRef?.nativeId);
        assert.strictEqual(fake.calls.filter((call) => call.method === "session/resume").length, 1);
        const again = yield* harness.runtime.resumeThread!({ providerThread: fresh });
        assert.strictEqual(again.id, fresh.id);
        assert.strictEqual(again.nativeThreadRef?.nativeId, fresh.nativeThreadRef?.nativeId);
        yield* harness.runtime.startTurn(yield* turnInput(fresh));
        const started = yield* fake.takeCall("turn/start");
        assert.strictEqual(started.params.sessionId, fresh.nativeThreadRef?.nativeId);
        yield* fake.emit("turn/completed", { turnId: started.commandId, terminal: "completed" });
        assert.strictEqual(
          (yield* harness.takeEvent("turn.terminal")).providerThreadId,
          original.id,
        );
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("forceNewNativeThread clears the previous native conversation head and context", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("session/contextUsage", { usedTokens: 100, windowTokens: 1000 });
      yield* harness.takeEvent(
        "provider_thread.updated",
        (event) => !!event.providerThread.contextUsage,
      );
      yield* fake.emit("turn/completed", { turnId: nativeId, terminal: "completed" });
      const previous = yield* harness.takeEvent(
        "provider_thread.updated",
        (event) => event.providerThread.nativeConversationHeadRef?.nativeId === nativeId,
      );
      yield* harness.takeEvent("turn.terminal");
      const fresh = yield* harness.runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection(),
        runtimePolicy,
        existingProviderThread: previous.providerThread,
        forceNewNativeThread: true,
      });
      assert.strictEqual(fresh.id, previous.providerThread.id);
      assert.isNull(fresh.nativeConversationHeadRef);
      assert.isNull(fresh.contextUsage);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("forceNewNativeThread ignores an initial native session before registration", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const adapter = yield* makeMuseAdapterV2({
        instanceId: INSTANCE_ID,
        settings: museSettings,
        environment: { PATH: "/fake/bin" },
        createHost: async () => fake.host,
      });
      const runtime = yield* adapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: ProviderSessionId.make("forced-session"),
        modelSelection: modelSelection(),
        runtimePolicy,
        initialNativeThreadId: "saved-session",
      });
      const existing = yield* preallocatedProviderThread();
      const fresh = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection(),
        runtimePolicy,
        forceNewNativeThread: true,
      });
      assert.notStrictEqual(fresh.nativeThreadRef?.nativeId, "saved-session");
      assert.strictEqual(fake.calls[0]?.method, "session/start");
      const replaced = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection(),
        runtimePolicy,
        existingProviderThread: existing,
        forceNewNativeThread: true,
      });
      assert.strictEqual(replaced.id, existing.id);
      assert.notStrictEqual(replaced.nativeThreadRef?.nativeId, fresh.nativeThreadRef?.nativeId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect.each(["active turn", "observed child", "held wake"] as const)(
    "forceNewNativeThread refuses replacement during %s without losing current work",
    (work) =>
      Effect.gen(function* () {
        const fake = yield* makeFakeMuse();
        const offered =
          yield* Deferred.make<ProviderContinuationRequests.ProviderContinuationRequest>();
        const harness = yield* makeHarness(
          fake,
          INSTANCE_ID,
          undefined,
          undefined,
          undefined,
          runtimePolicy,
          { continuationRequests: { offer: (request) => Deferred.succeed(offered, request) } },
        );
        if (work === "held wake") {
          yield* fake.emit("turn/started", { turnId: "held-turn" });
          yield* Deferred.await(offered);
        } else {
          const started = yield* startConversation(harness, fake);
          if (work === "observed child") {
            yield* fake.emit("item/started", {
              turnId: started.nativeId,
              item: {
                itemId: "background-child",
                kind: "subagent",
                revision: 1,
                status: "inProgress",
                turnId: started.nativeId,
                subagentId: "child-agent",
                controlStatus: "running",
                childSessionId: "child-session",
                objective: "Finish in the background",
              },
            });
            yield* harness.takeEvent("app_thread.created");
            yield* fake.emit("turn/completed", { turnId: started.nativeId, terminal: "completed" });
            yield* harness.takeEvent("turn.terminal");
          }
        }
        const before = fake.calls.length;
        const rejected = yield* harness.runtime
          .ensureThread({
            threadId: THREAD_ID,
            modelSelection: modelSelection(),
            runtimePolicy,
            existingProviderThread: harness.providerThread,
            forceNewNativeThread: true,
          })
          .pipe(Effect.exit);
        assert.strictEqual(rejected._tag, "Failure");
        assert.strictEqual(fake.calls.length, before);
        assert.strictEqual(fake.closeCount(), 0);
        if (work !== "active turn") assert.isTrue(yield* harness.runtime.hasPendingBackgroundWork!);
        if (work === "held wake") {
          const continuation = yield* Deferred.await(offered);
          assert.deepStrictEqual(
            yield* continuation.dispatchIfCurrent!(Effect.succeed("current")),
            Option.some("current"),
          );
        }
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("connects the thread's MCP credential on native start and resume", () =>
    Effect.gen(function* () {
      yield* (yield* McpProviderSessions.McpProviderSessions).set({
        environmentId: EnvironmentId.make("test-environment"),
        threadId: THREAD_ID,
        providerSessionId: "test-session",
        providerInstanceId: INSTANCE_ID,
        endpoint: "http://127.0.0.1:43210/mcp",
        authorizationHeader: "Bearer thread-scoped-test-token",
        browserToolsAvailable: true,
      });
      for (const nativeId of [undefined, "saved-native-session"]) {
        const fake = yield* makeFakeMuse();
        fake.host.initializeResult.grantedCapabilities.push("sessionMcp");
        yield* makeHarness(fake, INSTANCE_ID, nativeId);
        const call = yield* fake.takeCall(nativeId ? "session/resume" : "session/start");
        assert.deepStrictEqual(call.params.config, {
          mcpServers: {
            goat: {
              transport: "streamableHttp",
              mode: "optional",
              url: "http://127.0.0.1:43210/mcp",
              headers: { Authorization: "Bearer thread-scoped-test-token" },
            },
          },
        });
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("selects the runtime mode's permission profile on native start and resume", () =>
    Effect.gen(function* () {
      for (const [runtimeMode, profile, approvalMode] of [
        ["approval-required", ":ask-me", "promptUnmatched"],
        ["full-access", ":unrestricted", "allowAll"],
      ] as const) {
        const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          ...runtimePolicy,
          runtimeMode,
        });
        const fresh = yield* makeFakeMuse();
        yield* makeHarness(fresh, INSTANCE_ID, undefined, undefined, undefined, policy);
        const started = yield* fresh.takeCall("session/start");
        assert.strictEqual(started.params.permissionProfile, profile);
        assert.strictEqual(started.params.approvalMode, approvalMode);

        const saved = yield* makeFakeMuse();
        yield* makeHarness(saved, INSTANCE_ID, "saved-session", undefined, undefined, policy);
        const resumed = yield* saved.takeCall("session/resume");
        assert.strictEqual(resumed.params.permissionProfile, profile);
        const mode = yield* saved.takeCall("session/setApprovalMode");
        assert.strictEqual(mode.params.mode, approvalMode);
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rejects a host without session MCP support before opening a native session", () =>
    Effect.gen(function* () {
      yield* (yield* McpProviderSessions.McpProviderSessions).set({
        environmentId: EnvironmentId.make("test-environment"),
        threadId: THREAD_ID,
        providerSessionId: "test-session",
        providerInstanceId: INSTANCE_ID,
        endpoint: "http://127.0.0.1:43210/mcp",
        authorizationHeader: "Bearer thread-scoped-test-token",
        browserToolsAvailable: false,
      });
      const fake = yield* makeFakeMuse();
      const outcome = yield* makeHarness(fake).pipe(Effect.result);
      assert.strictEqual(outcome._tag, "Failure");
      assert.isFalse(fake.calls.some((call) => call.method === "session/start"));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("retries a missing native session with a cleared ref on the same healthy host", () =>
    Effect.gen(function* () {
      for (const kind of ["sessionNotFound", "notFound"] as const) {
        const fake = yield* makeFakeMuse();
        const allocated = yield* preallocatedProviderThread();
        const adapter = yield* makeMuseAdapterV2({
          instanceId: INSTANCE_ID,
          settings: museSettings,
          environment: { PATH: "/fake/bin" },
          createHost: async () => fake.host,
        });
        const runtime = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: ProviderSessionId.make(`missing-${kind}`),
          modelSelection: modelSelection(),
          runtimePolicy,
          initialNativeThreadId: "missing-session",
        });
        fake.queueResponse(
          "session/resume",
          new MspError({ code: -32000, message: "Saved session is absent", data: { kind } }),
        );
        const failed = yield* runtime
          .ensureThread({
            threadId: THREAD_ID,
            modelSelection: modelSelection(),
            runtimePolicy,
            existingProviderThread: {
              ...allocated,
              nativeThreadRef: {
                driver: MUSE_PROVIDER,
                nativeId: "missing-session",
                strength: "strong",
              },
            },
          })
          .pipe(Effect.exit);
        assert.strictEqual(failed._tag, "Failure");
        assert.strictEqual(fake.closeCount(), 0);
        const fresh = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection(),
          runtimePolicy,
          existingProviderThread: allocated,
        });
        assert.strictEqual(fresh.id, allocated.id);
        assert.notStrictEqual(fresh.nativeThreadRef?.nativeId, "missing-session");
        assert.strictEqual(fake.closeCount(), 0);
        yield* runtime.startTurn(yield* turnInput(fresh));
        const admitted = yield* fake.takeCall("turn/start");
        assert.strictEqual(admitted.params.reasoningEffort, "max");
        yield* fake.emit("turn/completed", { turnId: admitted.commandId, terminal: "completed" });
        yield* Stream.runDrain(
          runtime.events.pipe(Stream.takeUntil((event) => event.type === "turn.terminal")),
        );
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rejects cross-instance ensure requests without closing the current valid host", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const rejected = yield* harness.runtime
        .ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection(),
          runtimePolicy,
          existingProviderThread: {
            ...harness.providerThread,
            providerInstanceId: ProviderInstanceId.make("other-account"),
          },
        })
        .pipe(Effect.exit);
      assert.strictEqual(rejected._tag, "Failure");
      assert.strictEqual(fake.closeCount(), 0);
      yield* startConversation(harness, fake);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("pins Windows turns to Muse's verbatim root and starts Muse in the plain path", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      let hostCwd: string | undefined;
      const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        ...runtimePolicy,
        cwd: "C:\\work\\repo",
      });
      const harness = yield* makeHarness(
        fake,
        INSTANCE_ID,
        undefined,
        undefined,
        undefined,
        policy,
        {
          createHost: async (options) => {
            hostCwd = options.cwd;
            return fake.host;
          },
        },
      );
      yield* startConversation(harness, fake);
      const turnStart = fake.calls.find((call) => call.method === "turn/start");
      // Muse 1.4.3 accepts only verbatim canonical roots.
      assert.deepStrictEqual(turnStart?.params.workspaceRoots, ["\\\\?\\C:\\work\\repo"]);
      // The muse.cmd launcher runs under cmd.exe, which cannot start in a verbatim directory.
      assert.strictEqual(hostCwd, "C:\\work\\repo");
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.scoped,
      Effect.provide(testLayer),
    ),
  );

  it.effect("pins sessions and turns to native canonical case", () =>
    Effect.gen(function* () {
      using _realpath = vi.spyOn(NodeFSP, "realpath").mockResolvedValue("/workspace/eevee");
      const fake = yield* makeFakeMuse();
      const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        ...runtimePolicy,
        cwd: "/workspace/EEVEE",
      });
      const harness = yield* makeHarness(
        fake,
        INSTANCE_ID,
        undefined,
        undefined,
        undefined,
        policy,
      );
      yield* startConversation(harness, fake);
      const sessionStart = fake.calls.find((call) => call.method === "session/start");
      const turnStart = fake.calls.find((call) => call.method === "turn/start");
      assert.strictEqual(sessionStart?.params.workspaceRoot, "/workspace/eevee");
      assert.deepStrictEqual(turnStart?.params.workspaceRoots, [
        sessionStart?.params.workspaceRoot,
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(testLayer),
      Effect.provideService(HostProcess.Platform, "darwin"),
    ),
  );

  it.effect("stops at a Meta usage limit until every exhausted window resets", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      yield* fake.emitHostWide("usage/changed", {
        ...SUBSCRIPTION_USAGE,
        window: { ...SUBSCRIPTION_USAGE.window, usedPercent: 103 },
      });
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("turn/completed", {
        turnId: nativeId,
        terminal: "failed",
        reason: QUOTA_MESSAGE,
        error: { kind: "modelError", message: QUOTA_MESSAGE, retryable: false },
      });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.status, "failed");
      assert.strictEqual(terminal.threadDisposition, "reusable");
      assert.strictEqual(terminal.failure?.class, "usage_limit");
      assert.strictEqual(terminal.failure?.resetAt, "2026-10-08T13:19:17.000Z");
      assert.isTrue(
        harness.allEvents.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "error" &&
            event.turnItem.title === "Usage limit reached",
        ),
      );

      const next = yield* startConversation(harness, fake, 2);
      yield* fake.emit("turn/completed", {
        turnId: next.nativeId,
        terminal: "failed",
        error: { message: "API error 429: Rate limit exceeded. (rate_limit_error)" },
      });
      const throttled = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(throttled.failure?.class, "provider_error");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("resumes a quota stop at the reset the refusal names", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("turn/completed", {
        turnId: nativeId,
        terminal: "failed",
        reason: RELAYED_QUOTA_MESSAGE,
        error: { kind: "modelError", message: RELAYED_QUOTA_MESSAGE, retryable: true },
      });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.failure?.class, "usage_limit");
      assert.strictEqual(terminal.failure?.resetAt, "2026-10-13T10:45:52.000Z");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("limits a stop Muse types as quota at the reset it reports", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("turn/completed", {
        turnId: nativeId,
        terminal: "failed",
        error: {
          kind: "modelError",
          message: "Model request refused.",
          quota: { limitKind: "tierLimit", resetsAtMs: SUBSCRIPTION_USAGE.window.resetsAtMs },
          retryable: true,
        },
      });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.failure?.class, "usage_limit");
      assert.strictEqual(terminal.failure?.resetAt, "2026-10-08T13:19:17.000Z");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("skips an unreadable usage report without ending the session", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      yield* fake.emitHostWide("usage/changed", { window: "not usage" });
      yield* fake.emitHostWide("usage/changed", {
        ...SUBSCRIPTION_USAGE,
        window: { ...SUBSCRIPTION_USAGE.window, usedPercent: 103, resetsAtMs: 1e16 },
      });
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("turn/completed", {
        turnId: nativeId,
        terminal: "failed",
        error: { message: QUOTA_MESSAGE },
      });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.failure?.class, "usage_limit");
      assert.isUndefined(terminal.failure?.resetAt);
      assert.strictEqual(fake.closeCount(), 0);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("moves a resumed session on another model back to the catalog default", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(
        fake,
        INSTANCE_ID,
        "saved-session",
        undefined,
        undefined,
        runtimePolicy,
        {
          modelCatalog: Effect.succeed([
            {
              slug: "account-default",
              name: "Default",
              isCustom: false,
              isDefault: true,
              capabilities: null,
            },
            { slug: MODEL, name: "Other", isCustom: false, isDefault: false, capabilities: null },
          ]),
        },
      );
      const input = yield* turnInput(harness.providerThread, 1);
      const selection = { ...input.modelSelection, model: MUSE_DEFAULT_MODEL };
      yield* harness.runtime.startTurn({
        ...input,
        modelSelection: selection,
        appThread: { ...input.appThread, modelSelection: selection },
      });
      const setModel = yield* fake.takeCall("session/setModel");
      assert.deepStrictEqual(setModel.params.model, {
        modelId: "account-default",
        providerId: "meta",
      });
      yield* fake.takeCall("turn/start");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("settles partial messages and pending approvals before a provider failure", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("item/started", {
        turnId: nativeId,
        item: {
          itemId: "partial",
          turnId: nativeId,
          kind: "agentMessage",
          status: "inProgress",
          revision: 1,
          text: "Partial answer",
        },
      });
      yield* fake.emit("approval/requested", approval(nativeId));
      yield* harness.takeEvent(
        "runtime_request.updated",
        (event) => event.runtimeRequest.status === "pending",
      );
      yield* fake.emit("turn/completed", {
        turnId: nativeId,
        terminal: "failed",
        error: { message: "Provider rejected this turn" },
      });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.status, "failed");
      assert.strictEqual(terminal.threadDisposition, "reusable");
      assert.isNotNull(terminal.failure);
      assert.isTrue(
        harness.allEvents.some(
          (event) =>
            event.type === "message.updated" &&
            !event.message.streaming &&
            event.message.text === "Partial answer",
        ),
      );
      assert.isTrue(
        harness.allEvents.some(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "cancelled",
        ),
      );
      yield* startConversation(harness, fake, 2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect.each(["normal", "inherited pipe"] as const)(
    "closes its SDK host exactly once on session teardown with %s shutdown",
    (shutdown) =>
      Effect.gen(function* () {
        const fake = yield* makeFakeMuse();
        const pipeClosed = pendingPromise<void>();
        if (shutdown === "inherited pipe") fake.holdClose(pipeClosed.promise);
        let hostExited = false;
        void fake.host.exited.then(() => {
          hostExited = true;
        });
        const stopped: Array<{ unit: string; hostExited: boolean }> = [];
        const release = makeHarness(fake).pipe(
          Effect.scoped,
          Effect.provideService(AgentScope, {
            ...AgentScope.defaultValue(),
            wrap: ({ command, args }) =>
              Effect.succeed({ command, args, unit: "t3code-muse-test.scope" }),
            stop: (unit) =>
              Effect.sync(() => {
                stopped.push({ unit, hostExited });
                pipeClosed.resolve();
              }),
          }),
        );
        if (shutdown === "inherited pipe") {
          yield* Effect.gen(function* () {
            const releasing = yield* release.pipe(Effect.forkChild({ startImmediately: true }));
            yield* Effect.promise(() => fake.closing);
            yield* TestClock.adjust("12999 millis");
            assert.strictEqual(fake.closeCount(), 1);
            assert.deepStrictEqual(stopped, []);
            yield* TestClock.adjust("1 millis");
            assert.deepStrictEqual(
              [...stopped],
              [{ unit: "t3code-muse-test.scope", hostExited: false }],
            );
            yield* Fiber.join(releasing);
          }).pipe(Effect.ensuring(Effect.sync(() => pipeClosed.resolve())));
        } else {
          yield* release;
        }
        assert.strictEqual(fake.closeCount(), 1);
        assert.deepStrictEqual(stopped, [
          { unit: "t3code-muse-test.scope", hostExited: shutdown === "normal" },
        ]);
        yield* Effect.promise(() => fake.host.exited);
        assert.isTrue(hostExited);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "closes a newly opened host when native session registration returns another identity",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeMuse();
        fake.queueResponse("session/start", {
          session: { sessionId: "unexpected-session", modelId: MODEL, activeTurnId: null },
          history: { items: [] },
        });
        const result = yield* makeHarness(fake).pipe(Effect.exit);
        assert.strictEqual(result._tag, "Failure");
        yield* Effect.promise(() => fake.host.exited);
        assert.strictEqual(fake.closeCount(), 1);
        assert.strictEqual(fake.calls.filter((call) => call.method === "turn/start").length, 0);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "settles an active turn and reaps its scope on raw exit before inherited stdio closes",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeMuse();
        const pipeClosed = pendingPromise<void>();
        fake.holdClose(pipeClosed.promise);
        const stopped = yield* Deferred.make<void>();
        const units: string[] = [];
        let hostExited = false;
        let connectionClosed = false;
        void fake.host.exited.then(() => {
          hostExited = true;
        });
        void fake.host.connection.closed.then(() => {
          connectionClosed = true;
        });
        yield* Effect.gen(function* () {
          const harness = yield* makeHarness(fake);
          const { nativeId } = yield* startConversation(harness, fake);
          yield* fake.emit("approval/requested", approval(nativeId));
          yield* harness.takeEvent(
            "runtime_request.updated",
            (event) => event.runtimeRequest.status === "pending",
          );
          yield* fake.exitProcess();
          yield* Deferred.await(stopped);
          assert.deepStrictEqual(units, ["t3code-muse-exit.scope"]);
          const terminal = yield* harness.takeEvent("turn.terminal");
          assert.strictEqual(terminal.status, "failed");
          assert.strictEqual(terminal.threadDisposition, "broken");
          assert.isFalse(hostExited);
          assert.isFalse(connectionClosed);
          assert.isTrue(
            harness.allEvents.some(
              (event) =>
                event.type === "runtime_request.updated" &&
                event.runtimeRequest.status === "cancelled",
            ),
          );
          pipeClosed.resolve();
          yield* fake.disconnect();
          yield* Deferred.await(harness.eventsEnded);
          const result = yield* harness.runtime
            .startTurn(yield* turnInput(harness.providerThread, 2))
            .pipe(Effect.exit);
          assert.strictEqual(result._tag, "Failure");
          assert.strictEqual(
            harness.allEvents.filter((event) => event.type === "turn.terminal").length,
            1,
          );
          assert.strictEqual(fake.calls.filter((call) => call.method === "turn/start").length, 1);
        }).pipe(
          Effect.ensuring(Effect.sync(() => pipeClosed.resolve())),
          Effect.scoped,
          Effect.provideService(AgentScope, {
            ...AgentScope.defaultValue(),
            wrap: ({ command, args }) =>
              Effect.succeed({ command, args, unit: "t3code-muse-exit.scope" }),
            stop: (unit) =>
              Effect.gen(function* () {
                units.push(unit);
                yield* Deferred.succeed(stopped, undefined);
              }),
          }),
        );
        assert.deepStrictEqual(units, ["t3code-muse-exit.scope"]);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("settles an active turn once when both the connection and host exit unexpectedly", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const first = yield* startConversation(harness, fake);
      yield* fake.emit("item/started", {
        turnId: first.nativeId,
        item: {
          itemId: "background-child",
          kind: "subagent",
          revision: 1,
          status: "inProgress",
          turnId: first.nativeId,
          subagentId: "subagent-1",
          controlStatus: "running",
          childSessionId: "child-session-1",
          objective: "Finish in the background",
        },
      });
      const child = yield* harness.takeEvent("app_thread.created");
      yield* fake.emit("turn/completed", { turnId: first.nativeId, terminal: "completed" });
      yield* harness.takeEvent("turn.terminal");
      const { nativeId } = yield* startConversation(harness, fake, 2);
      yield* fake.emit("approval/requested", approval(nativeId));
      yield* harness.takeEvent(
        "runtime_request.updated",
        (event) => event.runtimeRequest.status === "pending",
      );
      yield* fake.disconnect();
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.status, "failed");
      assert.strictEqual(terminal.threadDisposition, "broken");
      assert.isTrue(
        harness.allEvents.some(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "cancelled",
        ),
      );
      const streamExit = yield* Deferred.await(harness.eventsEnded);
      assert.strictEqual(streamExit._tag, "Failure");
      assert.isTrue(
        harness.allEvents.some(
          (event) =>
            event.type === "subagent.updated" &&
            event.subagent.childThreadId === child.appThread.id &&
            event.subagent.status === "failed",
        ),
      );
      assert.isTrue(
        harness.allEvents.some(
          (event) =>
            event.type === "node.updated" &&
            event.node.threadId === child.appThread.id &&
            event.node.kind === "root_turn" &&
            event.node.status === "failed",
        ),
      );
      const result = yield* harness.runtime
        .startTurn(yield* turnInput(harness.providerThread, 3))
        .pipe(Effect.exit);
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(
        harness.allEvents.filter(
          (event) => event.type === "turn.terminal" && event.runOrdinal === 2,
        ).length,
        1,
      );
      assert.strictEqual(fake.calls.filter((call) => call.method === "turn/start").length, 2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("turns a delivery gap into a broken terminal and rejects subsequent work", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      yield* startConversation(harness, fake);
      yield* fake.emit("view/gap", {});
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.status, "failed");
      assert.strictEqual(terminal.threadDisposition, "broken");
      yield* Effect.promise(() => fake.host.exited);
      assert.strictEqual(fake.closeCount(), 1);
      yield* Deferred.await(harness.eventsEnded);
      const result = yield* harness.runtime
        .startTurn(yield* turnInput(harness.providerThread, 2))
        .pipe(Effect.exit);
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(fake.calls.filter((call) => call.method === "turn/start").length, 1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("uses the latest native approval requirement and waits for its resolution event", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("approval/requested", approval(nativeId));
      const first = yield* harness.takeEvent(
        "runtime_request.updated",
        (event) => event.runtimeRequest.status === "pending",
      );
      yield* fake.emit("approval/updated", {
        ...approval(nativeId),
        currentRequirementId: { approvalId: "approval-1", sourceIndex: 1 },
      });
      const refreshed = yield* harness.takeEvent(
        "runtime_request.updated",
        (event) => event.runtimeRequest.status === "pending",
      );
      assert.strictEqual(refreshed.runtimeRequest.id, first.runtimeRequest.id);
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: first.runtimeRequest.id,
        decision: "accept",
      });
      const decision = yield* fake.takeCall("approval/decide");
      assert.deepStrictEqual(decision.params.requirementId, {
        approvalId: "approval-1",
        sourceIndex: 1,
      });
      assert.strictEqual(decision.params.choiceId, "once");
      assert.isFalse(
        harness.allEvents.some(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "resolved",
        ),
      );
      yield* fake.emit("approval/resolved", { approvalId: "approval-1", turnId: nativeId });
      const resolved = yield* harness.takeEvent(
        "runtime_request.updated",
        (event) => event.runtimeRequest.status === "resolved",
      );
      assert.strictEqual(resolved.runtimeRequest.id, first.runtimeRequest.id);
      const repeated = yield* harness.runtime
        .respondToRuntimeRequest({ requestId: first.runtimeRequest.id, decision: "accept" })
        .pipe(Effect.exit);
      assert.strictEqual(repeated._tag, "Failure");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps the user's decision when Muse settles before acknowledging it", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("approval/requested", approval(nativeId));
      const pending = yield* harness.takeEvent(
        "runtime_request.updated",
        (event) => event.runtimeRequest.status === "pending",
      );
      const acknowledgement = pendingPromise<Record<string, unknown>>();
      fake.queueResponse("approval/decide", acknowledgement.promise);
      const responding = yield* harness.runtime
        .respondToRuntimeRequest({ requestId: pending.runtimeRequest.id, decision: "decline" })
        .pipe(Effect.forkScoped);
      yield* fake.takeCall("approval/decide");
      yield* fake.emit("approval/resolved", {
        approvalId: "approval-1",
        turnId: nativeId,
        decision: "abort",
      });
      const resolved = yield* harness.takeEvent(
        "runtime_request.updated",
        (event) => event.runtimeRequest.status === "resolved",
      );
      assert.strictEqual(resolved.runtimeRequest.decision, "decline");
      acknowledgement.resolve({});
      yield* Fiber.join(responding);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("lets a user turn take a held Muse report turn, approvals included", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
      const harness = yield* makeHarness(
        fake,
        INSTANCE_ID,
        undefined,
        undefined,
        undefined,
        runtimePolicy,
        { continuationRequests: { offer: (request) => Effect.sync(() => offers.push(request)) } },
      );
      yield* fake.emit("turn/started", { turnId: "report-1" });
      yield* Effect.yieldNow;
      assert.lengthOf(offers, 1);
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("approval/requested", approval("report-1"));
      const asked = yield* harness.takeEvent(
        "runtime_request.updated",
        (event) => event.runtimeRequest.status === "pending",
      );
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: asked.runtimeRequest.id,
        decision: "accept",
      });
      yield* fake.takeCall("approval/decide");
      yield* fake.emit("approval/resolved", { approvalId: "approval-1", turnId: "report-1" });
      yield* fake.emit("turn/completed", { turnId: "report-1", terminal: "completed" });
      yield* fake.emit("turn/completed", { turnId: nativeId, terminal: "completed" });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.status, "completed");
      const dispatched = yield* offers[0]!.dispatchIfCurrent!(Effect.succeed("run"));
      assert.isTrue(Option.isNone(dispatched));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect.each([
    { when: "after its turn ended", turnEnded: true },
    { when: "while its turn runs", turnEnded: false },
  ] as const)(
    "hides a workflow child's automatic approval $when and retains completed history",
    ({ turnEnded }) =>
      Effect.gen(function* () {
        const fake = yield* makeFakeMuse();
        const harness = yield* makeHarness(fake);
        const { nativeId } = yield* startConversation(harness, fake);
        if (turnEnded) {
          yield* fake.emit("turn/completed", { turnId: nativeId, terminal: "completed" });
          yield* harness.takeEvent("turn.terminal");
        }
        const acknowledgement = pendingPromise<Record<string, unknown>>();
        fake.queueResponse("approval/decide", acknowledgement.promise);
        const child = { ...approval("child-run-1"), subagentOrigin: { subagentId: "a7" } };
        const before = harness.allEvents.length;
        yield* fake.emit("approval/requested", child);
        const decision = yield* fake.takeCall("approval/decide");
        assert.strictEqual(decision.params.choiceId, "once");
        const snapshot = yield* harness.runtime.readThreadSnapshot!({
          providerThread: harness.providerThread,
        });
        assert.deepStrictEqual(snapshot.runtimeRequests, []);
        assert.deepStrictEqual(harness.allEvents.slice(before), []);
        if (!turnEnded) {
          const parent = {
            ...approval(nativeId),
            approvalId: "parent-approval",
            currentRequirementId: { approvalId: "parent-approval", sourceIndex: 0 },
          };
          yield* fake.emit("approval/requested", parent);
          const shown = yield* harness.takeEvent("runtime_request.updated");
          assert.strictEqual(shown.runtimeRequest.status, "pending");
          yield* harness.takeEvent("provider_session.updated");
          yield* fake.emit("approval/resolved", parent);
          // The child remains unacknowledged when the visible request stops blocking the turn.
          const session = yield* harness.takeEvent("provider_session.updated");
          assert.strictEqual(session.providerSession.status, "running");
        }
        yield* fake.emit("approval/resolved", child);
        const resolved = yield* harness.takeEvent("runtime_request.updated");
        assert.strictEqual(resolved.runtimeRequest.status, "resolved");
        assert.strictEqual(resolved.runtimeRequest.decision, "accept");
        assert.isNull(resolved.runtimeRequest.providerTurnId);
        const node = yield* harness.takeEvent("node.updated");
        const item = yield* harness.takeEvent("turn_item.updated");
        assert.strictEqual(node.node.status, "completed");
        assert.strictEqual(item.turnItem.status, "completed");
        acknowledgement.resolve({});
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("reveals only the current failed child approval and sends the user's decline", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      yield* startConversation(harness, fake);
      const outdated = pendingPromise<Record<string, unknown>>();
      const current = pendingPromise<Record<string, unknown>>();
      fake.queueResponse("approval/decide", outdated.promise);
      fake.queueResponse("approval/decide", current.promise);
      const child = {
        ...approval("child-run-1"),
        subagentOrigin: {
          subagentId: "a7",
          childRunId: "child-run-1",
          childSessionId: "child-session",
        },
      };
      yield* fake.emit("approval/requested", child);
      yield* fake.takeCall("approval/decide");
      yield* fake.emit("approval/updated", {
        approvalId: child.approvalId,
        availableChoices: child.availableChoices,
        subject: child.subject,
        subagentOrigin: child.subagentOrigin,
        currentRequirementId: { approvalId: "approval-1", sourceIndex: 1 },
      });
      const second = yield* fake.takeCall("approval/decide");
      assert.deepStrictEqual(second.params.requirementId, {
        approvalId: "approval-1",
        sourceIndex: 1,
      });
      outdated.reject(
        new MspError({
          code: -32053,
          message: "Stale requirement",
          data: { kind: "approvalRequirementStale" },
        }),
      );
      current.reject(
        new MspError({
          code: -32052,
          message: "Choice rejected",
          data: { kind: "approvalChoiceInvalid" },
        }),
      );
      const asked = yield* harness.takeEvent("runtime_request.updated");
      assert.strictEqual(asked.runtimeRequest.status, "pending");
      const waiting = yield* harness.takeEvent("provider_session.updated");
      assert.strictEqual(waiting.providerSession.status, "waiting");
      const snapshot = yield* harness.runtime.readThreadSnapshot!({
        providerThread: harness.providerThread,
      });
      assert.deepStrictEqual(snapshot.runtimeRequests, [asked.runtimeRequest]);
      assert.lengthOf(
        harness.allEvents.filter((event) => event.type === "runtime_request.updated"),
        1,
      );
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: asked.runtimeRequest.id,
        decision: "decline",
      });
      const decline = yield* fake.takeCall("approval/decide");
      assert.strictEqual(decline.params.choiceId, "deny");
      assert.deepStrictEqual(decline.params.requirementId, second.params.requirementId);
      yield* fake.emit("approval/resolved", child);
      const resolved = yield* harness.takeEvent("runtime_request.updated");
      assert.strictEqual(resolved.runtimeRequest.decision, "decline");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("does not resurrect a settled child approval when its automatic answer fails", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      yield* startConversation(harness, fake);
      const acknowledgement = pendingPromise<Record<string, unknown>>();
      fake.queueResponse("approval/decide", acknowledgement.promise);
      const child = { ...approval("child-run-1"), subagentOrigin: { subagentId: "a7" } };
      yield* fake.emit("approval/requested", child);
      yield* fake.takeCall("approval/decide");
      yield* fake.emit("approval/resolved", child);
      const resolved = yield* harness.takeEvent("runtime_request.updated");
      assert.strictEqual(resolved.runtimeRequest.status, "resolved");
      acknowledgement.reject(
        new MspError({
          code: -32051,
          message: "Already resolved",
          data: { kind: "approvalAlreadyResolved" },
        }),
      );
      // A later rejected answer provides an observable milestone after the stale rejection.
      fake.queueResponse("approval/decide", new Error("Choice rejected"));
      yield* fake.emit("approval/requested", {
        ...child,
        approvalId: "approval-2",
        currentRequirementId: { approvalId: "approval-2", sourceIndex: 0 },
      });
      const asked = yield* harness.takeEvent("runtime_request.updated");
      assert.strictEqual(asked.runtimeRequest.nativeRequestRef?.nativeId, "approval-2");
      assert.deepStrictEqual(
        harness.allEvents.flatMap((event) =>
          event.type === "runtime_request.updated" ? [event.runtimeRequest.status] : [],
        ),
        ["resolved", "pending"],
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps a workflow child's approval pending for the user past the turn's end", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        ...runtimePolicy,
        runtimeMode: "approval-required",
      });
      const harness = yield* makeHarness(
        fake,
        INSTANCE_ID,
        undefined,
        undefined,
        undefined,
        policy,
      );
      const { nativeId } = yield* startConversation(harness, fake);
      const childApproval = { ...approval("child-run-1"), subagentOrigin: { subagentId: "a7" } };
      yield* fake.emit("approval/requested", childApproval);
      const asked = yield* harness.takeEvent("runtime_request.updated");
      assert.isNull(asked.runtimeRequest.providerTurnId);
      yield* fake.emit("turn/completed", { turnId: nativeId, terminal: "completed" });
      yield* harness.takeEvent("turn.terminal");
      assert.isFalse(
        harness.allEvents.some(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status !== "pending",
        ),
      );
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: asked.runtimeRequest.id,
        decision: "decline",
      });
      const decision = yield* fake.takeCall("approval/decide");
      assert.strictEqual(decision.params.choiceId, "deny");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("validates structured answers and preserves selected labels with a custom note", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("userInput/requested", {
        userInputId: "question-1",
        turnId: nativeId,
        questions: [
          {
            id: "approach",
            header: "Approach",
            question: "Which approach?",
            options: [{ label: "Small" }, { label: "Large" }],
            selection: { mode: "single" },
          },
        ],
      });
      const pending = yield* harness.takeEvent(
        "runtime_request.updated",
        (event) => event.runtimeRequest.kind === "user_input",
      );
      const invalid = yield* harness.runtime
        .respondToRuntimeRequest({
          requestId: pending.runtimeRequest.id,
          answers: { approach: ["Small", "Large"] },
        })
        .pipe(Effect.exit);
      assert.strictEqual(invalid._tag, "Failure");
      assert.isFalse(fake.calls.some((call) => call.method === "userInput/answer"));
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: pending.runtimeRequest.id,
        answers: { approach: ["Small", "Keep tests focused"] },
      });
      const response = yield* fake.takeCall("userInput/answer");
      assert.deepStrictEqual(response.params.answers, [
        { questionId: "approach", selectedLabel: "Small", note: "Keep tests focused" },
      ]);
      yield* fake.emit("userInput/settled", {
        userInputId: "question-1",
        turnId: nativeId,
        answers: response.params.answers,
      });
      yield* harness.takeEvent(
        "runtime_request.updated",
        (event) => event.runtimeRequest.status === "resolved",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("steers only the active native turn and waits for confirmed interruption", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const turn = yield* startConversation(harness, fake);
      const input = yield* turnInput(harness.providerThread);
      const invalid = yield* harness.runtime.steerTurn!({
        threadId: THREAD_ID,
        runId: input.runId,
        providerThread: harness.providerThread,
        providerTurnId: ProviderTurnId.make("unrelated-turn"),
        message: input.message,
      }).pipe(Effect.exit);
      assert.strictEqual(invalid._tag, "Failure");
      assert.isFalse(fake.calls.some((call) => call.method === "turn/steer"));
      yield* harness.runtime.steerTurn!({
        threadId: THREAD_ID,
        runId: input.runId,
        providerThread: harness.providerThread,
        providerTurnId: turn.providerTurn.id,
        message: { ...input.message, text: "Focus on the parser" },
      });
      assert.strictEqual((yield* fake.takeCall("turn/steer")).params.expectedTurnId, turn.nativeId);
      const interrupt = yield* harness.runtime
        .interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: turn.providerTurn.id,
        })
        .pipe(Effect.forkScoped);
      assert.strictEqual((yield* fake.takeCall("turn/interrupt")).params.turnId, turn.nativeId);
      yield* fake.emit("turn/completed", { turnId: turn.nativeId, terminal: "cancelled" });
      yield* Fiber.join(interrupt);
      assert.strictEqual((yield* harness.takeEvent("turn.terminal")).status, "interrupted");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("resumes the requested native session and reads the same session snapshot", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const nativeItem: MuseItem = {
        itemId: "prior-message",
        turnId: "prior-turn",
        kind: "agentMessage",
        status: "completed",
        revision: 1,
        text: "Previous answer",
      };
      fake.setHistory([nativeItem]);
      const harness = yield* makeHarness(fake, INSTANCE_ID, "saved-session");
      const resumed = yield* fake.takeCall("session/resume");
      assert.strictEqual(resumed.params.sessionId, "saved-session");
      assert.strictEqual(resumed.params.excludeItems, true);
      assert.isFalse(fake.calls.some((call) => call.method === "session/start"));
      assert.strictEqual(harness.providerThread.nativeThreadRef?.nativeId, "saved-session");
      const snapshot = yield* harness.runtime.readThreadSnapshot!({
        providerThread: harness.providerThread,
      });
      assert.strictEqual(snapshot.providerThread.nativeThreadRef?.nativeId, "saved-session");
      assert.deepStrictEqual(snapshot.providerPayload, [nativeItem]);
      assert.strictEqual(snapshot.messages[0]?.text, "Previous answer");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect.each([
    { resume: true, label: "resumes the saved session" },
    { resume: false, label: "starts a fresh session" },
  ])("completes a turn after an idle host dies and $label", ({ resume }) =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse("first");
      const recovery = yield* makeFakeMuse("second");
      const harness = yield* makeHarness(fake, INSTANCE_ID, "saved-session", recovery);
      yield* fake.disconnect();
      yield* harness.takeEvent(
        "provider_session.updated",
        (event) => event.providerSession.status === "error",
      );

      const reEnsured = yield* harness.runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection(),
        runtimePolicy,
        existingProviderThread: resume
          ? harness.providerThread
          : { ...harness.providerThread, nativeThreadRef: null },
      });
      const registered = yield* recovery.takeCall(resume ? "session/resume" : "session/start");
      assert.strictEqual(registered.params.sessionId, reEnsured.nativeThreadRef?.nativeId);
      assert.strictEqual(reEnsured.id, harness.providerThread.id);
      assert.strictEqual(reEnsured.nativeThreadRef?.nativeId === "saved-session", resume);

      yield* harness.runtime.startTurn(yield* turnInput(reEnsured));
      const started = yield* recovery.takeCall("turn/start");
      yield* recovery.emit("turn/completed", {
        turnId: started.commandId,
        terminal: "completed",
      });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.status, "completed");
      assert.strictEqual(terminal.providerThreadId, reEnsured.id);
      assert.strictEqual(terminal.threadDisposition, "reusable");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("discards a dead host's pending continuation before relaunching", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse("first");
      const recovery = yield* makeFakeMuse("second");
      const offered =
        yield* Deferred.make<ProviderContinuationRequests.ProviderContinuationRequest>();
      const harness = yield* makeHarness(
        fake,
        INSTANCE_ID,
        "saved-session",
        recovery,
        undefined,
        runtimePolicy,
        { continuationRequests: { offer: (request) => Deferred.succeed(offered, request) } },
      );
      yield* fake.emit("turn/started", { turnId: "dead-host-report" });
      const continuation = yield* Deferred.await(offered);
      assert.isTrue(yield* harness.runtime.hasPendingBackgroundWork!);
      yield* fake.disconnect();
      yield* harness.takeEvent(
        "provider_session.updated",
        (event) => event.providerSession.status === "error",
      );
      assert.isFalse(yield* harness.runtime.hasPendingBackgroundWork!);
      const dispatched = yield* continuation.dispatchIfCurrent!(
        Effect.die("Stale continuation dispatched"),
      );
      assert.isTrue(Option.isNone(dispatched));

      const reEnsured = yield* harness.runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection(),
        runtimePolicy,
        existingProviderThread: harness.providerThread,
      });
      const input = yield* turnInput(reEnsured);
      yield* harness.runtime.startTurn({
        ...input,
        message: { ...input.message, createdBy: "agent", creationSource: "provider" },
      });
      const running = yield* harness.takeEvent("provider_turn.updated");
      assert.notStrictEqual(running.providerTurn.nativeTurnRef?.nativeId, "dead-host-report");
      assert.strictEqual((yield* harness.takeEvent("turn.terminal")).status, "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("serializes interruption behind pending turn admission without losing the target", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const admission = pendingPromise<Record<string, unknown>>();
      fake.queueResponse("turn/start", admission.promise);
      const starting = yield* harness.runtime
        .startTurn(yield* turnInput(harness.providerThread))
        .pipe(Effect.forkScoped);
      const call = yield* fake.takeCall("turn/start");
      const running = yield* harness.takeEvent(
        "provider_turn.updated",
        (event) => event.providerTurn.status === "running",
      );
      const stopping = yield* harness.runtime
        .interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: running.providerTurn.id,
        })
        .pipe(Effect.forkScoped);
      admission.resolve({ turnId: call.commandId });
      yield* Fiber.join(starting);
      assert.strictEqual((yield* fake.takeCall("turn/interrupt")).params.turnId, call.commandId);
      yield* fake.emit("turn/completed", { turnId: call.commandId, terminal: "cancelled" });
      yield* Fiber.join(stopping);
      assert.strictEqual((yield* harness.takeEvent("turn.terminal")).status, "interrupted");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps an intentionally interrupted compaction closed on ensureThread", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const recovery = yield* makeFakeMuse("replacement");
      const harness = yield* makeHarness(fake, INSTANCE_ID, undefined, recovery);
      yield* harness.runtime.compactThread!(yield* turnInput(harness.providerThread));
      const running = yield* harness.takeEvent("provider_turn.updated");
      yield* harness.runtime.interruptTurn({
        providerThread: harness.providerThread,
        providerTurnId: running.providerTurn.id,
      });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.status, "interrupted");
      assert.strictEqual(terminal.threadDisposition, "broken");
      assert.strictEqual((yield* Deferred.await(harness.eventsEnded))._tag, "Success");

      const result = yield* harness.runtime
        .ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection(),
          runtimePolicy,
          existingProviderThread: harness.providerThread,
        })
        .pipe(Effect.exit);
      assert.strictEqual(result._tag, "Failure");
      assert.deepStrictEqual(recovery.calls, []);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("reports a no-op compaction as a visible failure and permits another turn", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      fake.queueResponse("session/compact", { status: "noop", reason: "no_compactable_history" });
      yield* harness.runtime.compactThread!(yield* turnInput(harness.providerThread));
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.status, "failed");
      assert.strictEqual(terminal.threadDisposition, "reusable");
      yield* startConversation(harness, fake, 2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("projects native todos with stable identity and removes cancelled steps", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("item/completed", {
        turnId: nativeId,
        item: {
          itemId: "todo-tool",
          turnId: nativeId,
          kind: "toolCall",
          tool: "write_todos",
          revision: 1,
          status: "completed",
        },
      });
      yield* fake.emit("item/started", {
        turnId: nativeId,
        item: {
          itemId: "reminder",
          turnId: nativeId,
          kind: "reminderChild",
          revision: 1,
          status: "inProgress",
          fallbackText: "Reminder child session",
        },
      });
      yield* fake.emit("session/todoListChanged", {
        items: [
          { text: " Investigate ", status: "completed" },
          { text: "Fix", status: "inProgress" },
          { text: "Discarded", status: "cancelled" },
          { text: "  ", status: "pending" },
        ],
      });
      const first = yield* harness.takeEvent(
        "turn_item.updated",
        (event) => event.turnItem.type === "todo_list",
      );
      assert.strictEqual(first.turnItem.type, "todo_list");
      if (first.turnItem.type !== "todo_list") return;
      assert.deepStrictEqual(
        first.turnItem.steps.map(({ text, status }) => ({ text, status })),
        [
          { text: "Investigate", status: "completed" },
          { text: "Fix", status: "running" },
        ],
      );
      const planId = first.turnItem.planId;
      yield* fake.emit("session/todoListChanged", {
        items: [
          { text: "Investigate", status: "completed" },
          { text: "Fix", status: "completed" },
        ],
      });
      const next = yield* harness.takeEvent(
        "turn_item.updated",
        (event) => event.turnItem.type === "todo_list",
      );
      assert.strictEqual(next.turnItem.id, first.turnItem.id);
      assert.strictEqual(next.turnItem.nodeId, first.turnItem.nodeId);
      if (next.turnItem.type !== "todo_list") return;
      assert.strictEqual(next.turnItem.planId, first.turnItem.planId);
      assert.isTrue(
        harness.allEvents.some(
          (event) =>
            event.type === "plan.updated" &&
            event.plan.id === planId &&
            event.plan.status === "completed",
        ),
      );
      assert.isFalse(
        harness.allEvents.some(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool",
        ),
      );
      assert.isTrue((yield* harness.adapter.getCapabilities()).planning.emitsPlanUpdated);
      assert.isTrue((yield* harness.adapter.getCapabilities()).planning.emitsTodoList);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("opens a prompt-and-result child thread for a native subagent", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("item/started", {
        turnId: nativeId,
        item: {
          itemId: "sub-1",
          kind: "subagent",
          revision: 1,
          status: "inProgress",
          turnId: nativeId,
          subagentId: "subagent-1",
          controlStatus: "running",
          childSessionId: "child-session-1",
          objective: "Check the thing",
          role: "general-purpose",
        },
      });
      const created = yield* harness.takeEvent("app_thread.created");
      const childThreadId = created.appThread.id;
      yield* fake.emit("item/updated", {
        turnId: nativeId,
        item: {
          itemId: "sub-1",
          kind: "subagent",
          revision: 2,
          status: "inProgress",
          turnId: nativeId,
          subagentId: "subagent-1",
          controlStatus: "resultReady",
          childSessionId: "child-session-1",
          objective: "Check the thing",
          result: { summary: "All done" },
        },
      });
      const completed = yield* harness.takeEvent(
        "subagent.updated",
        (event) => event.subagent.status === "completed",
      );
      assert.strictEqual(completed.subagent.title, created.appThread.title);
      const result = yield* harness.takeEvent(
        "message.updated",
        (event) => event.message.threadId === childThreadId && event.message.role === "assistant",
      );
      assert.strictEqual(result.message.text, "All done");
      yield* fake.emit("turn/completed", { turnId: nativeId, terminal: "completed" });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.status, "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps a workflow child's first label after later revisions drop it", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
      const workflowItem = (revision: number, children: unknown) => ({
        itemId: "wf-1",
        kind: "workflow",
        revision,
        status: "inProgress",
        turnId: nativeId,
        entryId: "Probe workflow",
        children,
      });
      yield* fake.emit("item/started", {
        turnId: nativeId,
        item: workflowItem(1, [{ childId: "c1", attempt: 1, status: "scheduled", label: "ping" }]),
      });
      const scheduled = yield* harness.takeEvent("subagent.updated");
      assert.strictEqual(scheduled.subagent.title, "ping");
      yield* fake.emit("item/updated", {
        turnId: nativeId,
        item: workflowItem(2, [{ childId: "c1", attempt: 1, status: "started" }]),
      });
      const started = yield* harness.takeEvent(
        "subagent.updated",
        (event) => event.subagent.status === "running",
      );
      assert.strictEqual(started.subagent.title, "ping");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("shows a workflow child that completed with a failure kind as failed", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("item/started", {
        turnId: nativeId,
        item: {
          itemId: "wf-1",
          kind: "workflow",
          revision: 1,
          status: "inProgress",
          turnId: nativeId,
          children: [
            {
              childId: "c1",
              attempt: 1,
              status: "finished",
              terminal: "completed",
              failureKind: "budget_exhausted",
            },
          ],
        },
      });
      const child = yield* harness.takeEvent("subagent.updated");
      assert.strictEqual(child.subagent.status, "failed");
      assert.strictEqual(child.subagent.result, "budget_exhausted");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
