import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  HandoffError,
  WS_METHODS,
  type AuthClientSession,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  durableHandoffs,
  instanceId,
  threadId,
  withHarness,
} from "../handoffs/Handoffs.testkit.ts";
import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { requestClaim } from "../mcp/toolkits/preview/browserClaims/handlers.ts";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import { makeTestBrowserOriginGrants } from "./BrowserOriginGrants.testkit.ts";
import { BrowserClaimHandoffs, makeBrowserClaimHandoffs } from "./BrowserClaimHandoffs.ts";
import { makeBrowserClaimsRpcHandlers } from "./BrowserClaimsRpcHandlers.ts";

const setup = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  failCreate = false,
  gate?: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> },
  createGate?: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> },
) =>
  Effect.gen(function* () {
    const environmentId = EnvironmentId.make("test-environment");
    const grants = yield* makeTestBrowserOriginGrants({
      environmentId,
      supported: () => true,
      publish: () => Effect.void,
      windowTitle: () => Effect.succeed("Observed window"),
      bind: (input) =>
        (gate
          ? Deferred.succeed(gate.entered, undefined).pipe(
              Effect.andThen(Deferred.await(gate.release)),
            )
          : Effect.void
        ).pipe(
          Effect.as({
            targetId: "target",
            tabId: "tab",
            title: "Site",
            url: input.origin,
            driverGeneration: 1,
          }),
        ),
    });
    const now = yield* DateTime.now;
    const session: AuthClientSession = {
      sessionId: AuthSessionId.make("session:test"),
      subject: "desktop-bootstrap",
      method: "browser-session-cookie",
      scopes: ["orchestration:operate", "settings:write"],
      client: { label: "Person", deviceType: "unknown" },
      issuedAt: now,
      expiresAt: DateTime.add(now, { days: 1 }),
      lastConnectedAt: now,
      connected: true,
      current: true,
    };
    const fixture = yield* durableHandoffs(orchestrator, {
      environmentId,
      sessions: Effect.succeed([session]),
      browserClaimResponder: {
        register: () => Effect.void,
        answer: (id, approved) =>
          grants
            .answer(id, approved)
            .pipe(Effect.mapError((cause) => new HandoffError({ reason: "unavailable", cause }))),
      },
    });
    const actual = yield* fixture.start;
    const handoffs = failCreate
      ? { ...actual, create: () => Effect.fail(new HandoffError({ reason: "unavailable" })) }
      : createGate
        ? {
            ...actual,
            create: (input: Parameters<typeof actual.create>[0]) =>
              actual.create(input).pipe(
                Effect.tap(() => Deferred.succeed(createGate.entered, undefined)),
                Effect.tap(() => Deferred.await(createGate.release)),
              ),
          }
        : actual;
    const bridge = yield* makeBrowserClaimHandoffs({
      grants,
      handoffs,
      threads: orchestrator,
      environmentId,
      events: orchestrator.streamDomainEvents,
    });
    const request = requestClaim({ pid: 42, windowId: 7, origin: "https://example.test" }).pipe(
      Effect.provideService(BrowserClaimHandoffs, bridge),
      Effect.provideService(McpInvocationContext, {
        environmentId,
        requestNamespace: "session:test",
        thread: { threadId, providerInstanceId: instanceId, providerSessionId: "session:test" },
        client: undefined,
        capabilities: new Set<never>(),
        issuedAt: 0,
      }),
    );
    return { grants, handoffs, request, session };
  });

it.effect("an agent request creates exactly one card with the observed title and origin", () =>
  withHarness(({ orchestrator, worker }) =>
    Effect.gen(function* () {
      const f = yield* setup(orchestrator);
      const result = yield* f.request;
      assert.equal(result.status, "pending");
      yield* worker.drain();
      const items = (yield* orchestrator.getThreadProjection(threadId)).turnItems.filter(
        (item) => item.type === "human_handoff",
      );
      assert.lengthOf(items, 1);
      const handoff = items[0]?.type === "human_handoff" ? items[0].handoff : undefined;
      assert.equal(handoff?.target.path, "browser_claim.answer");
      assert.include(handoff?.reason ?? "", "Observed window");
      assert.include(handoff?.reason ?? "", "https://example.test");
      assert.include(handoff?.reason ?? "", "already");
      if (result.status !== "pending") return assert.fail("expected pending");
      assert.equal((yield* f.grants.listAll()).pending[0]?.claimId, result.claimId);
    }),
  ),
);

it.effect("person-initiated claims attach without an approval card", () =>
  withHarness(({ orchestrator, worker }) =>
    Effect.gen(function* () {
      const f = yield* setup(orchestrator);
      const result = yield* f.grants.claim({
        threadId,
        pid: 42,
        windowId: 7,
        origin: "https://example.test",
        windowTitle: "Observed window",
      });
      assert.equal(result.agentResult.status, "attached");
      yield* worker.drain();
      assert.lengthOf(
        (yield* orchestrator.getThreadProjection(threadId)).turnItems.filter(
          (item) => item.type === "human_handoff",
        ),
        0,
      );
    }),
  ),
);

it.effect("failed card creation declines the pending claim", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      const f = yield* setup(orchestrator, true);
      assert.equal((yield* f.request.pipe(Effect.result))._tag, "Failure");
      assert.lengthOf((yield* f.grants.listAll()).pending, 0);
    }),
  ),
);

it.effect.each(["answer", "stop", "stop_all", "blocked", "restart"] as const)(
  "%s cancels the open approval card",
  (ending) =>
    withHarness(({ orchestrator, worker }) =>
      Effect.gen(function* () {
        const f = yield* setup(orchestrator);
        const request = yield* f.request;
        if (request.status !== "pending") return assert.fail("expected pending");
        yield* worker.drain();
        const item = (yield* orchestrator.getThreadProjection(threadId)).turnItems.find(
          (value) => value.type === "human_handoff",
        );
        if (!item || item.type !== "human_handoff") return assert.fail("expected card");
        const ended = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "turn-item.updated" &&
              event.payload.type === "human_handoff" &&
              event.payload.handoff?.handoffId === item.id &&
              event.payload.handoff.state === "cancelled",
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        if (ending === "answer") {
          const handlers = makeBrowserClaimsRpcHandlers(
            Option.some({ ...f.grants, setDriverCapability: () => Effect.void }),
            { subject: "desktop-bootstrap" },
          );
          yield* handlers[WS_METHODS.browserClaimsAnswer]({
            claimId: request.claimId,
            approved: false,
          });
        } else if (ending === "stop") yield* f.grants.stop(threadId);
        else if (ending === "stop_all") yield* f.grants.stop();
        else if (ending === "blocked") yield* f.grants.blockedHostsChanged(["example.test"]);
        else yield* f.grants.driverRestarted(() => {});
        yield* Fiber.join(ended);
        assert.equal((yield* f.handoffs.read({ threadId, handoffId: item.id })).state, "cancelled");
      }),
    ),
);

it.effect.each(["cancel", "expiry"] as const)("%s of a card declines its pending claim", (ending) =>
  withHarness(({ orchestrator, worker }) =>
    Effect.gen(function* () {
      const f = yield* setup(orchestrator);
      const request = yield* f.request;
      if (request.status !== "pending") return assert.fail("expected pending");
      yield* worker.drain();
      const item = (yield* orchestrator.getThreadProjection(threadId)).turnItems.find(
        (value) => value.type === "human_handoff",
      );
      if (!item || item.type !== "human_handoff") return assert.fail("expected card");
      const ended = yield* f.grants.changes.pipe(
        Stream.mapEffect(() => f.grants.listAll()),
        Stream.filter(
          (snapshot) => !snapshot.pending.some((value) => value.claimId === request.claimId),
        ),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );
      if (ending === "cancel")
        yield* f.handoffs.respond(
          { threadId, handoffId: item.id, action: "cancelled" },
          f.session.sessionId,
        );
      else yield* TestClock.adjust("15 minutes");
      yield* Fiber.join(ended);
      assert.lengthOf((yield* f.grants.listAll()).pending, 0);
      assert.equal(
        (yield* f.handoffs.read({ threadId, handoffId: item.id })).state,
        ending === "cancel" ? "cancelled" : "expired",
      );
    }),
  ),
);

it.effect("a card answer racing Stop leaves one declined card and no claim", () =>
  withHarness(({ orchestrator, worker }) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const f = yield* setup(orchestrator, false, { entered, release });
      const request = yield* f.request;
      if (request.status !== "pending") return assert.fail("expected pending");
      yield* worker.drain();
      const item = (yield* orchestrator.getThreadProjection(threadId)).turnItems.find(
        (value) => value.type === "human_handoff",
      );
      if (!item || item.type !== "human_handoff") return assert.fail("expected card");
      const answer = yield* f.handoffs
        .respond({ threadId, handoffId: item.id, action: "completed" }, f.session.sessionId)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      yield* f.grants.stop(threadId);
      assert.equal((yield* Fiber.join(answer)).state, "declined");
      yield* Deferred.succeed(release, undefined);
      yield* worker.drain();
      assert.equal((yield* f.handoffs.read({ threadId, handoffId: item.id })).state, "declined");
      assert.lengthOf((yield* f.grants.listAll()).pending, 0);
      assert.lengthOf((yield* f.grants.listAll()).claims, 0);
    }),
  ),
);

it.effect("a service restart cancels cards whose claims no longer exist", () =>
  withHarness(({ orchestrator, worker }) =>
    Effect.gen(function* () {
      const f = yield* setup(orchestrator);
      const request = yield* f.request;
      if (request.status !== "pending") return assert.fail("expected pending");
      yield* worker.drain();
      const item = (yield* orchestrator.getThreadProjection(threadId)).turnItems.find(
        (value) => value.type === "human_handoff",
      );
      if (!item || item.type !== "human_handoff") return assert.fail("expected card");
      const grants = yield* makeTestBrowserOriginGrants({
        environmentId: EnvironmentId.make("test-environment"),
        supported: () => true,
        publish: () => Effect.void,
        bind: () => Effect.die("no bind"),
      });
      yield* makeBrowserClaimHandoffs({
        grants,
        handoffs: f.handoffs,
        threads: orchestrator,
        environmentId: EnvironmentId.make("test-environment"),
        events: orchestrator.streamDomainEvents,
      });
      assert.equal((yield* f.handoffs.read({ threadId, handoffId: item.id })).state, "cancelled");
    }),
  ),
);

it.effect("a Stop during card creation cancels the card after creation", () =>
  withHarness(({ orchestrator, worker }) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const f = yield* setup(orchestrator, false, undefined, { entered, release });
      const request = yield* f.request.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      yield* f.grants.stop(threadId);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(request);
      yield* worker.drain();
      const item = (yield* orchestrator.getThreadProjection(threadId)).turnItems.find(
        (value) => value.type === "human_handoff",
      );
      if (!item || item.type !== "human_handoff") return assert.fail("expected card");
      assert.equal((yield* f.handoffs.read({ threadId, handoffId: item.id })).state, "cancelled");
      assert.lengthOf((yield* f.grants.listAll()).pending, 0);
    }),
  ),
);

it.effect("approving the card attaches its bound claim and records the result", () =>
  withHarness(({ orchestrator, worker }) =>
    Effect.gen(function* () {
      const f = yield* setup(orchestrator);
      const request = yield* f.request;
      if (request.status !== "pending") return assert.fail("expected pending");
      yield* worker.drain();
      const item = (yield* orchestrator.getThreadProjection(threadId)).turnItems.find(
        (value) => value.type === "human_handoff",
      );
      if (!item || item.type !== "human_handoff") return assert.fail("expected card");
      const result = yield* f.handoffs.respond(
        { threadId, handoffId: item.id, action: "completed" },
        f.session.sessionId,
      );
      assert.equal(result.state, "completed");
      assert.equal(result.resultMessage, "Attached");
      assert.equal((yield* f.grants.list(threadId)).claims[0]?.claimId, request.claimId);
    }),
  ),
);

it.effect("declining the card keeps the agent result identical to a decline", () =>
  withHarness(({ orchestrator, worker }) =>
    Effect.gen(function* () {
      const f = yield* setup(orchestrator);
      const request = yield* f.request;
      if (request.status !== "pending") return assert.fail("expected pending");
      yield* worker.drain();
      const item = (yield* orchestrator.getThreadProjection(threadId)).turnItems.find(
        (value) => value.type === "human_handoff",
      );
      if (!item || item.type !== "human_handoff") return assert.fail("expected card");
      const result = yield* f.handoffs.respond(
        { threadId, handoffId: item.id, action: "declined" },
        f.session.sessionId,
      );
      assert.equal(result.state, "declined");
      assert.deepEqual((yield* f.grants.answer(request.claimId, false)).agentResult, {
        status: "refused",
        code: "declined",
        message: "The person did not approve this request.",
      });
    }),
  ),
);
