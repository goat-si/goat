import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  type AuthClientSession,
  type ComputerUseCapabilities,
  type ComputerUseRequestInput,
  EnvironmentId,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as Environment from "../environment/ServerEnvironment.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import {
  durableHandoffs,
  instanceId,
  threadId,
  withHarness,
} from "../handoffs/Handoffs.testkit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import { requestComputerUse } from "./ComputerUseRequests.ts";
import * as CuaDriver from "./CuaDriver.ts";

type Signals = ComputerUseCapabilities["signals"];
const supported = { humanInput: "supported", privateMode: "supported" } satisfies Signals;

/**
 * The real leases, on a host whose helper's accepted readiness reported these signals;
 * undefined: a host whose helper never reported.
 */
const leasesDetecting = (signals: Signals | undefined) =>
  ComputerUseLeases.layer.pipe(
    Layer.provide(
      DesktopTelemetryReceiver.layerTest({
        cuaReadiness: Effect.succeed(
          signals === undefined
            ? Option.none()
            : Option.some({
                version: 1,
                type: "cuaReadiness",
                generation: 1,
                readiness: {
                  grants: { accessibility: "granted", screenCapture: "granted" },
                  helper: "authenticated",
                  capture: "ready",
                  tree: "ready",
                  input: "background",
                  blockers: [],
                  reasons: [],
                },
                signals,
              } as const),
        ),
      }),
    ),
  );

const purpose = "Check the build status window";
const sessionId = AuthSessionId.make("person:request-tests");
const requestWithHandoffs =
  (handoffs: Handoffs.Handoffs["Service"]) =>
  (request: Partial<ComputerUseRequestInput> = {}) =>
    requestComputerUse({
      threadId,
      providerInstanceId: instanceId,
      request: { purpose, minutes: 30, ...request },
    }).pipe(Effect.provideService(Handoffs.Handoffs, handoffs));

const withRequests = <A, E, R>(
  orchestrator: Parameters<Parameters<typeof withHarness>[0]>[0]["orchestrator"],
  signals: Signals | undefined,
  body: (input: {
    request: ReturnType<typeof requestWithHandoffs>;
    handoffs: Handoffs.Handoffs["Service"];
    leases: ComputerUseLeases.ComputerUseLeases["Service"];
  }) => Effect.Effect<A, E, R>,
  beforeCompletion?: (
    leases: ComputerUseLeases.ComputerUseLeases["Service"],
  ) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const environmentId = EnvironmentId.make("test-environment");
    const now = yield* DateTime.now;
    const person: AuthClientSession = {
      sessionId,
      subject: "desktop-bootstrap",
      method: "browser-session-cookie",
      scopes: ["orchestration:operate", "settings:write"],
      client: { label: "Test person", deviceType: "desktop" },
      issuedAt: now,
      expiresAt: DateTime.add(now, { days: 1 }),
      lastConnectedAt: now,
      connected: true,
      current: true,
    };
    const leases = yield* ComputerUseLeases.ComputerUseLeases;
    const { start } = yield* durableHandoffs(
      {
        ...orchestrator,
        dispatch: (command) =>
          command.type === "handoff.transition" &&
          command.state === "completed" &&
          beforeCompletion !== undefined
            ? beforeCompletion(leases).pipe(Effect.andThen(orchestrator.dispatch(command)))
            : orchestrator.dispatch(command),
      },
      {
        environmentId,
        sessions: Effect.succeed([person]),
      },
    );
    const handoffs = yield* start;
    return yield* body({
      request: requestWithHandoffs(handoffs),
      handoffs,
      leases,
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        leasesDetecting(signals),
        Layer.mock(CuaDriver.CuaDriver)({ enabled: Effect.succeed(true) }),
        Layer.mock(Environment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadSnapshot: orchestrator.getThreadSnapshot,
        }),
      ),
    ),
    Effect.provideService(HostProcess.Hostname, "test-host"),
  );

it.effect(
  "work that runs on its own is refused unless the helper reports both safety signals supported",
  () =>
    withHarness(({ orchestrator }) =>
      Effect.gen(function* () {
        for (const signals of [
          undefined,
          { humanInput: "unsupported", privateMode: "unsupported" },
          { humanInput: "supported", privateMode: "unsupported" },
          { humanInput: "unsupported", privateMode: "supported" },
        ] satisfies ReadonlyArray<Signals | undefined>) {
          const result = yield* withRequests(orchestrator, signals, ({ request }) => request());
          assert.equal(result.kind, "refused", JSON.stringify(signals));
          if (result.kind === "refused") assert.equal(result.reason, "detection_unsupported");
        }
        const allowed = yield* withRequests(orchestrator, supported, ({ request }) => request());
        assert.equal(allowed.kind, "needs_human");
      }),
    ),
);

it.effect("a repeated request announces the pending handoff's original expiry", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request }) =>
      Effect.gen(function* () {
        const first = yield* request();
        assert.equal(first.kind, "needs_human");
        yield* TestClock.adjust("10 minutes");
        const repeated = yield* request();
        if (first.kind !== "needs_human" || repeated.kind !== "needs_human")
          return assert.fail("both requests should wait for a person");
        assert.equal(repeated.handoff.handoffId, first.handoff.handoffId);
        const expiresAt = repeated.handoff.expiresAt;
        if (expiresAt === null) return assert.fail("a computer use handoff carries its expiry");
        assert.include(repeated.message, `before ${DateTime.formatIso(expiresAt)},`);
      }),
    ),
  ),
);

it.effect(
  "foreground with any apps list refuses desktop-only approval without creating a handoff",
  () =>
    withHarness(({ orchestrator }) =>
      withRequests(orchestrator, supported, ({ request }) =>
        Effect.gen(function* () {
          for (const apps of [[], ["com.example.editor"]]) {
            const result = yield* request({ foreground: true, apps });
            assert.equal(result.kind, "refused");
            if (result.kind !== "refused")
              return assert.fail("foreground must not broaden an apps list");
            assert.equal(result.reason, "unsupported");
            assert.include(result.message, "whole-desktop");
          }
          const records = yield* orchestrator.getThreadRecords(threadId, ["turnItems"]);
          assert.isFalse(records.turnItems.some((item) => item.type === "human_handoff"));
        }),
      ),
    ),
);

it.effect("a background approval cannot satisfy a foreground request for the same purpose", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs }) =>
      Effect.gen(function* () {
        const background = yield* request();
        if (background.kind !== "needs_human") return assert.fail("background waits for approval");
        yield* handoffs.respond(
          { threadId, handoffId: background.handoff.handoffId, action: "completed" },
          sessionId,
        );
        assert.equal((yield* request({ foreground: false })).kind, "available");
        const foreground = yield* request({ foreground: true });
        assert.equal(foreground.kind, "needs_human");
        if (foreground.kind === "needs_human")
          assert.notEqual(foreground.handoff.handoffId, background.handoff.handoffId);
      }),
    ),
  ),
);

it.effect(
  "omitted and false reuse legacy background args while true has separate persisted disclosure",
  () =>
    withHarness(({ orchestrator }) =>
      withRequests(orchestrator, supported, ({ request, handoffs }) =>
        Effect.gen(function* () {
          const omitted = yield* request();
          const explicitFalse = yield* request({ foreground: false });
          const foreground = yield* request({ foreground: true });
          const repeated = yield* request({ foreground: true });
          if (
            omitted.kind !== "needs_human" ||
            explicitFalse.kind !== "needs_human" ||
            foreground.kind !== "needs_human" ||
            repeated.kind !== "needs_human"
          )
            return assert.fail("pending modes should each wait for a person");
          assert.equal(explicitFalse.handoff.handoffId, omitted.handoff.handoffId);
          assert.equal(repeated.handoff.handoffId, foreground.handoff.handoffId);
          assert.notEqual(foreground.handoff.handoffId, omitted.handoff.handoffId);
          const backgroundCard = yield* handoffs.open(
            { threadId, handoffId: omitted.handoff.handoffId },
            sessionId,
          );
          assert.isUndefined(backgroundCard.handoff.computerUseForeground);
          assert.include(backgroundCard.handoff.reason, "Background-only");
          assert.include(backgroundCard.human?.location ?? "", "Background-only");
          const card = yield* handoffs.open(
            { threadId, handoffId: foreground.handoff.handoffId },
            sessionId,
          );
          assert.deepEqual(card.handoff.computerUseForeground, { purpose, target: "desktop" });
          assert.isUndefined(card.handoff.apps);
          for (const disclosure of [card.handoff.reason, card.human?.location ?? ""]) {
            for (const required of [
              purpose,
              "Whole-desktop",
              "focus",
              "Pause",
              "Stop",
              "replacement",
              DateTime.formatIso(card.handoff.expiresAt!),
            ])
              assert.include(disclosure, required);
          }
        }),
      ),
    ),
);

it.effect(
  "a person's first completion binds the purpose once; pause and repeated completion cannot resurrect it",
  () =>
    withHarness(({ orchestrator }) =>
      withRequests(orchestrator, supported, ({ request, handoffs, leases }) =>
        Effect.gen(function* () {
          const asked = yield* request({ foreground: true });
          if (asked.kind !== "needs_human") return assert.fail("foreground waits for a person");
          const address = { threadId, handoffId: asked.handoff.handoffId };
          assert.isFalse(yield* leases.foregroundAvailable(threadId, purpose));
          yield* handoffs.respond({ ...address, action: "opened" }, sessionId);
          assert.isFalse(yield* leases.foregroundAvailable(threadId, purpose));
          const completed = yield* handoffs.respond({ ...address, action: "completed" }, sessionId);
          assert.deepEqual(completed.computerUseForeground, { purpose, target: "desktop" });
          yield* leases.control(threadId, yield* leases.active(threadId));
          assert.isTrue(yield* leases.foregroundAvailable(threadId, purpose));
          assert.equal((yield* request({ foreground: true })).kind, "available");
          assert.equal(
            (yield* request({ foreground: true, purpose: "A different purpose" })).kind,
            "needs_human",
          );
          const persisted = yield* handoffs.read(address);
          assert.deepEqual(persisted.computerUseForeground, completed.computerUseForeground);
          // A fresh server's map cannot be rebuilt from the completed projection.
          const afterRestart = yield* Effect.gen(function* () {
            const fresh = yield* ComputerUseLeases.ComputerUseLeases;
            return yield* fresh.foregroundAvailable(threadId, purpose);
          }).pipe(Effect.provide(Layer.fresh(leasesDetecting(supported))));
          assert.isFalse(afterRestart);
          yield* leases.pause("human_input");
          yield* leases.resume;
          yield* handoffs.respond({ ...address, action: "completed" }, sessionId);
          assert.isFalse(yield* leases.foregroundAvailable(threadId, purpose));
          assert.equal((yield* request({ foreground: true })).kind, "needs_human");
          assert.equal((yield* request()).kind, "available");
        }),
      ),
    ),
);

it.effect(
  "Stop between the first approval read and its commit fences foreground authority even without a control",
  () =>
    withHarness(({ orchestrator }) =>
      withRequests(
        orchestrator,
        supported,
        ({ request, handoffs, leases }) =>
          Effect.gen(function* () {
            const asked = yield* request({ foreground: true });
            if (asked.kind !== "needs_human") return assert.fail("foreground waits for a person");
            const completed = yield* handoffs.respond(
              { threadId, handoffId: asked.handoff.handoffId, action: "completed" },
              sessionId,
            );
            assert.equal(completed.state, "completed");
            yield* leases.control(threadId, yield* leases.active(threadId));
            assert.isFalse(yield* leases.foregroundAvailable(threadId, purpose));
            assert.equal((yield* request({ foreground: true })).kind, "needs_human");
          }),
        (leases) => leases.stop(threadId).pipe(Effect.asVoid),
      ),
    ),
);

it.effect("an expired foreground request never binds authority when a person completes it", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs, leases }) =>
      Effect.gen(function* () {
        const asked = yield* request({ foreground: true });
        if (asked.kind !== "needs_human") return assert.fail("foreground waits for a person");
        yield* TestClock.adjust("30 minutes");
        const result = yield* handoffs
          .respond({ threadId, handoffId: asked.handoff.handoffId, action: "completed" }, sessionId)
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure._tag, "HandoffError");
        assert.isFalse(yield* leases.foregroundAvailable(threadId, purpose));
      }),
    ),
  ),
);
