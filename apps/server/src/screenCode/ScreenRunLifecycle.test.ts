import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeUrl from "node:url";
import { EnvironmentAuthorizationError, type EnvironmentId, type ProviderInstanceId,
  type ScreenHostCall, type ThreadId } from "@goat/contracts";
import { ScreenHostBridge } from "./ScreenHostBridge.ts";
import { screenRunLimits } from "./ScreenRunLimits.ts";
import { makeTabClaims, TabClaims } from "./TabClaims.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";

const context = {
  runId: "run", turnId: "turn", cellId: "cell", threadId: "thread", environmentId: "env",
  limits: screenRunLimits(),
  invocation: {
    environmentId: "env" as EnvironmentId,
    capabilities: new Set(["preview" as const]),
    issuedAt: 0, requestNamespace: "test", client: undefined,
    thread: { threadId: "thread" as ThreadId, providerSessionId: "session",
      providerInstanceId: "provider" as ProviderInstanceId },
    reauthorize: () => Effect.void,
  },
};
const call = (kind: "tab" | "app", callId: number): ScreenHostCall => ({
  t: "call", runId: "run", turnId: "turn", cellId: "cell", callId,
  targetRef: { id: kind, kind, environmentId: "env", runId: "run", turnId: "turn", generation: 0 },
  method: "click", args: {}, deadlineMillis: 100,
});

for (const [first, next, title] of [
  ["app", "tab", "desktop private during a mixed cell blocks the next browser effect"],
  ["tab", "app", "tab Stop during a mixed cell blocks the next desktop effect"],
] as const) {
  it.effect(title, () => Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    let dispatched = 0;
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: () => Effect.gen(function* () {
        dispatched++;
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(finish);
        return { category: "confirmed" as const, evidence: ["after-cut"] };
      }),
    });
    const pending = yield* bridge.handle(call(first, 1), context).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* bridge.cutCell("run", "turn", "cell", "control changed");
    const late = yield* Fiber.join(pending);
    yield* Deferred.succeed(finish, undefined);
    const blocked = yield* bridge.handle(call(next, 2), context);
    const journal = yield* bridge.takeCellImages("run", "turn", "cell");
    expect(late?.outcome).toBe("error");
    expect(late && "error" in late ? late.error?.code : undefined).toBe("unknown_outcome");
    expect(blocked && "error" in blocked ? blocked.error?.code : undefined).toBe("stopped");
    expect(dispatched).toBe(1);
    expect(journal.journal[0]?.receipt).toMatchObject({
      journalState: "unknown", category: "unknown_outcome", dispatched: true,
    });
  }));
}

it.effect("Turn completion closes a temporary tab before releasing its claim and records failure", () =>
  Effect.gen(function* () {
    let heldDuringClose = false;
    const identity = { environmentId: "env", threadId: "thread", runId: "run", turnId: "turn",
      browserInstanceId: "browser", connectionId: "connection", tabId: "temporary",
      controlGeneration: 1 };
    let claims: TabClaims["Service"];
    claims = yield* makeTabClaims(() => Effect.gen(function* () {
      heldDuringClose = (yield* claims.assertCurrent(identity).pipe(Effect.option))._tag === "Some";
      return yield* Effect.die(new Error("close failed"));
    }));
    yield* claims.recordOpened(identity);
    const authority = yield* claims.captureCleanup(identity);
    const outcomes = yield* claims.releaseTurn(identity, authority);
    expect(heldDuringClose).toBe(true);
    expect(outcomes).toEqual([{ tabId: "temporary", status: "failed" }]);
    expect((yield* claims.assertCurrent(identity).pipe(Effect.option))._tag).toBe("None");
  }),
);

it.effect("The call ceiling refuses the next effect with prior receipts", () =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    let dispatched = 0;
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: () => Effect.sync(() => {
        dispatched++;
        return { category: "confirmed" as const, evidence: ["done"] };
      }),
    });
    const limited = { ...context, limits: screenRunLimits({ callsPerCell: 1 }) };
    const first = yield* bridge.handle(call("app", 1), limited);
    const second = yield* bridge.handle(call("app", 2), limited);
    expect(first?.outcome).toBe("ok");
    expect(second && "error" in second ? second.error : undefined).toMatchObject({
      code: "call_limit", effectStarted: false,
      limit: { name: "callsPerCell", maximum: 1 },
      receipts: [{ callId: 1, category: "confirmed" }],
    });
    expect(dispatched).toBe(1);
  }),
);

it.effect("Stop releases the tab claim while a later cell can claim fresh authority", () =>
  Effect.gen(function* () {
    const identity = { environmentId: "env", threadId: "thread", runId: "run", turnId: "turn",
      browserInstanceId: "browser", connectionId: "connection", tabId: "temporary",
      controlGeneration: 1 };
    let closed = 0;
    const claims = yield* makeTabClaims(() => Effect.sync(() => { closed++; }));
    yield* claims.recordOpened(identity);
    yield* claims.suspendClaims(identity, identity.tabId);
    expect((yield* claims.assertCurrent(identity).pipe(Effect.option))._tag).toBe("None");
    expect((yield* claims.recordOpened({ ...identity, tabId: "later", controlGeneration: 2 })).claimEpoch).toBeGreaterThan(0);
    const cutoff = yield* claims.captureCleanup(identity);
    expect((yield* claims.releaseTurn(identity, cutoff)).map((item) => item.status)).toEqual(["closed", "closed"]);
    expect(closed).toBe(2);
  }),
);

it.effect("Credential revocation fences the next desktop effect in the same cell", () =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    let dispatched = 0;
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: () => Effect.sync(() => {
        dispatched++;
        return { category: "confirmed" as const, evidence: ["done"] };
      }),
    });
    const revoked = { ...context, invocation: { ...context.invocation,
      reauthorize: () => Effect.fail(new EnvironmentAuthorizationError({
        message: "The session was revoked.", requiredScope: "memory:read",
      })) } };
    const first = yield* bridge.handle(call("tab", 1), revoked);
    const second = yield* bridge.handle(call("app", 2), revoked);
    expect(first && "error" in first ? first.error?.code : undefined).toBe("permission_denied");
    expect(second && "error" in second ? second.error?.code : undefined).toBe("stopped");
    expect(dispatched).toBe(0);
  }),
);

it.live("Pause kills the current child and requires a fresh binding before the next observation", () => {
  let nextTarget = 0;
  let observations = 0;
  const request = { runId: "run", turnId: "turn", threadId: "thread", environmentId: "env",
    invocation: context.invocation };
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const first = yield* service.runCell({ ...request,
      source: "return (await screen.tab({tabId: 'tab'})).targetRef;" });
    expect(first.status).toBe("completed");
    yield* service.controlChanged({ kind: "pause", threadId: "thread" });
    const stale = yield* service.runCell({ ...request,
      source: "return 2;" });
    expect(stale.status).toBe("completed");
    expect(observations).toBe(0);
    const fresh = yield* service.runCell({ ...request,
      source: "const tab = await screen.tab({tabId: 'tab'}); return await tab.observe();" });
    expect(fresh.value).toEqual({ tree: "fresh" });
    expect(observations).toBe(1);
    yield* service.finishTurn({ runId: "run", turnId: "turn", threadId: "thread",
      environmentId: "env", reason: "test" });
  }).pipe(Effect.provide(ScreenRunService.layerWithRuntime({
    invocation: { command: process.execPath,
      entrypoint: NodeUrl.fileURLToPath(new URL("../bin.ts", import.meta.url)) },
    assetResolver: () => resolveScreenRuntimeAsset("dev"),
    dispatcher: {
      availability: () => Effect.succeed([{ kind: "tab", available: true }]),
      dispatch: (call) => Effect.sync(() => call.method === "bind_tab"
        ? { value: { targetRef: { id: `target-${++nextTarget}`, kind: "tab" as const,
            environmentId: "env", runId: "run", turnId: "turn", generation: 0 },
            tab: { tabId: "tab" } }, category: "confirmed" as const, evidence: ["bound"] }
        : (observations++, { value: { tree: "fresh" }, category: "confirmed" as const,
            evidence: ["observed"] })),
    },
  }).pipe(Layer.provide(NodeServices.layer))));
});
