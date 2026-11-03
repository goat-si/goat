import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  HandoffError,
  type AuthClientSession,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { makeTestBrowserOriginGrants } from "../preview/BrowserOriginGrants.testkit.ts";
import { durableHandoffs, instanceId, threadId, withHarness } from "./Handoffs.testkit.ts";

it.effect(
  "an approval started before expiry stays completed if attachment finishes after expiry",
  () =>
    withHarness(({ orchestrator, worker }) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const environmentId = EnvironmentId.make("test-environment");
        const grants = yield* makeTestBrowserOriginGrants({
          environmentId,
          supported: () => true,
          publish: () => Effect.void,
          bind: (input) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({
                targetId: "target",
                tabId: "tab",
                title: "Site",
                url: input.origin,
                driverGeneration: 1,
              }),
            ),
        });
        const pending = yield* grants.request({
          threadId,
          pid: 42,
          windowId: 7,
          origin: "https://example.test",
          windowTitle: "Site",
        });
        if (pending.status !== "pending") return assert.fail("expected pending claim");
        const now = yield* DateTime.now;
        const sessionId = AuthSessionId.make("session:browser-claim");
        const client: AuthClientSession = {
          sessionId,
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
          sessions: Effect.succeed([client]),
          browserClaimResponder: {
            register: () => Effect.void,
            answer: (id, approved) =>
              grants
                .answer(id, approved)
                .pipe(
                  Effect.mapError((cause) => new HandoffError({ reason: "unavailable", cause })),
                ),
          },
        });
        const service = yield* fixture.start;
        const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
        const card = yield* service.create({
          kind: "approval",
          title: "Use tab",
          reason: "Site https://example.test",
          requestedBy: { threadId, providerInstanceId: instanceId, path: "browser_claim.request" },
          target: { environmentId, path: "browser_claim.answer" },
          runId: run.id,
          nodeId: run.rootNodeId!,
          human: { location: "Browser" },
          args: { claimId: pending.claimId },
          expiresAt: DateTime.add(now, { minutes: 1 }),
        });
        yield* worker.drain();
        const address = { threadId, handoffId: card.handoffId };
        const answer = yield* service
          .respond({ ...address, action: "completed" }, sessionId)
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* TestClock.adjust("2 minutes");
        yield* Deferred.succeed(release, undefined);
        assert.equal((yield* Fiber.join(answer)).state, "completed");
        yield* service.sweep;
        yield* worker.drain();
        assert.equal((yield* service.read(address)).state, "completed");
        assert.lengthOf((yield* grants.list(threadId)).claims, 1);
      }),
    ),
);

it.effect("Stop during claim attachment resolves the card as declined without deadlock", () =>
  withHarness(({ orchestrator, worker }) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const environmentId = EnvironmentId.make("test-environment");
      const grants = yield* makeTestBrowserOriginGrants({
        environmentId,
        supported: () => true,
        publish: () => Effect.void,
        bind: (input) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({
              targetId: "target",
              tabId: "tab",
              title: "Site",
              url: input.origin,
              driverGeneration: 1,
            }),
          ),
      });
      const pending = yield* grants.request({
        threadId,
        pid: 42,
        windowId: 7,
        origin: "https://example.test",
        windowTitle: "Site",
      });
      if (pending.status !== "pending") return assert.fail("expected pending claim");
      const now = yield* DateTime.now;
      const sessionId = AuthSessionId.make("session:browser-claim");
      const client: AuthClientSession = {
        sessionId,
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
        sessions: Effect.succeed([client]),
        browserClaimResponder: {
          register: () => Effect.void,
          answer: (id, approved) =>
            grants
              .answer(id, approved)
              .pipe(Effect.mapError((cause) => new HandoffError({ reason: "unavailable", cause }))),
        },
      });
      const service = yield* fixture.start;
      const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
      const card = yield* service.create({
        kind: "approval",
        title: "Use tab",
        reason: "Site https://example.test",
        requestedBy: { threadId, providerInstanceId: instanceId, path: "browser_claim.request" },
        target: { environmentId, path: "browser_claim.answer" },
        runId: run.id,
        nodeId: run.rootNodeId!,
        human: { location: "Browser" },
        args: { claimId: pending.claimId },
        expiresAt: DateTime.add(now, { minutes: 1 }),
      });
      yield* worker.drain();
      const address = { threadId, handoffId: card.handoffId };
      const answer = yield* service
        .respond({ ...address, action: "completed" }, sessionId)
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* grants.stop(threadId);
      assert.equal((yield* Fiber.join(answer)).state, "declined");
      yield* Deferred.succeed(release, undefined);
      yield* service.sweep;
      yield* worker.drain();
      assert.equal((yield* service.read(address)).state, "declined");
      assert.lengthOf((yield* grants.list(threadId)).claims, 0);
    }),
  ),
);
