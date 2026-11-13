import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { now, scope, remoteOk, run, staleCodex } from "./HostStatusMcpService.testkit.ts";

it.effect("signed-in clients share one read of each host and reuse it for 30 s", () =>
  Effect.gen(function* () {
    const client = (sessionId: string) => ({
      environmentId: EnvironmentId.make("host-status-test"),
      sessionId,
      reachHosts: true,
    });
    const { value, calls } = yield* run({ hosts: ["box"] }, (service) =>
      Effect.gen(function* () {
        yield* service.readForClient(client("web"));
        yield* service.readForClient(client("fleet-placement"));
        yield* TestClock.adjust("31 seconds");
        return yield* service.readForClient(client("phone"));
      }),
    );
    expect(value._tag).toBe("Success");
    expect(calls.map((call) => call.host)).toEqual(["box", "box"]);
  }),
);

it.effect("clients reading at once share one read of a host still answering", () =>
  Effect.gen(function* () {
    const answer = yield* Deferred.make<void>();
    const client = (sessionId: string) => ({
      environmentId: EnvironmentId.make("host-status-test"),
      sessionId,
      reachHosts: true,
    });
    const { value, calls } = yield* run(
      {
        hosts: ["box"],
        hostCall: () => Deferred.await(answer).pipe(Effect.as(remoteOk(2))),
      },
      (service) =>
        Effect.gen(function* () {
          const first = yield* Effect.forkChild(service.readForClient(client("web")));
          const second = yield* Effect.forkChild(service.readForClient(client("fleet-health")));
          yield* Effect.forkChild(Deferred.succeed(answer, undefined));
          return [yield* Fiber.join(first), yield* Fiber.join(second)];
        }),
    );
    expect(value._tag).toBe("Success");
    expect(calls.map((call) => call.host)).toEqual(["box"]);
  }),
);

it.effect("a caller without orchestration never gets a shared answer", () =>
  Effect.gen(function* () {
    const denied: McpInvocationScope = {
      environmentId: EnvironmentId.make("host-status-test"),
      requestNamespace: "client-session:denied",
      thread: undefined,
      client: { sessionId: "denied", label: "GOAT client", access: "read-only" },
      issuedAt: 0,
      capabilities: new Set(),
    };
    const { value } = yield* run({ hosts: ["box"] }, (service) =>
      Effect.gen(function* () {
        yield* service.readForClient({
          environmentId: EnvironmentId.make("host-status-test"),
          sessionId: "web",
          reachHosts: true,
        });
        return yield* service.read(denied, { host: "box" }, { shared: true });
      }),
    );
    expect(value._tag).toBe("Failure");
    if (value._tag !== "Failure") return;
    expect(value.failure.code).toBe("capability_denied");
  }),
);

it.effect("an agent always asks the host, and its wider read never answers a client", () =>
  Effect.gen(function* () {
    const { calls } = yield* run({ hosts: ["box"] }, (service) =>
      Effect.gen(function* () {
        yield* service.read(scope, { repositories: true });
        yield* service.read(scope, {});
        yield* service.read(scope, {}, { shared: true });
        yield* service.readForClient({
          environmentId: EnvironmentId.make("host-status-test"),
          sessionId: "web",
          reachHosts: true,
        });
      }),
    );
    expect(calls.map((call) => call.arguments)).toEqual([
      { local: true, repositories: true },
      { local: true },
      { local: true },
      { local: true },
    ]);
  }),
);

it.effect("a status read answers from the last quota reading while the provider probe runs", () =>
  Effect.gen(function* () {
    const { value } = yield* run(
      { providers: staleCodex(), probe: () => Effect.sleep("30 seconds") },
      (service, probes) =>
        Effect.gen(function* () {
          const read = yield* service.read(scope, { local: true }).pipe(
            Effect.flatMap((result) =>
              Clock.currentTimeMillis.pipe(Effect.map((answeredAt) => ({ result, answeredAt }))),
            ),
            Effect.forkChild,
          );
          yield* Queue.take(probes.started);
          yield* TestClock.adjust("30 seconds");
          const first = yield* Fiber.join(read);
          yield* Queue.take(probes.finished);
          const second = yield* service.read(scope, { local: true });
          return { first, second };
        }),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    const { first, second } = value.success;
    expect(first.answeredAt).toBe(now);
    expect(first.result.hosts[0]?.metrics?.quotas[0]).toMatchObject({
      fromCache: true,
      limits: { checkedAt: "2026-10-12T15:00:00.000Z" },
    });
    expect(second.hosts[0]?.metrics?.quotas[0]?.limits.checkedAt).toBe("2026-10-12T16:00:30.000Z");
  }),
);

it.effect(
  "status reads probe a provider no more often than the provider health refresh interval",
  () =>
    Effect.gen(function* () {
      const { value, refreshes } = yield* run(
        { providers: staleCodex(), settings: { backgroundActivity: { profile: "battery-saver" } } },
        (service) =>
          Effect.gen(function* () {
            // Fleet clients read every 15 s; battery saver checks providers every 15 minutes.
            for (let read = 0; read < 64; read++) {
              yield* service.read(scope, { local: true });
              yield* TestClock.adjust("15 seconds");
            }
          }),
      );
      expect(value._tag).toBe("Success");
      expect(refreshes).toEqual(["codex", "codex"]);
    }),
);

it.effect("concurrent status reads start one provider probe", () =>
  Effect.gen(function* () {
    const { value, refreshes } = yield* run(
      { providers: staleCodex(), probe: () => Effect.sleep("30 seconds") },
      (service, probes) =>
        Effect.gen(function* () {
          const reads = yield* Effect.all(
            [service.read(scope, { local: true }), service.read(scope, { local: true })],
            { concurrency: "unbounded" },
          ).pipe(Effect.forkChild);
          yield* Queue.take(probes.started);
          yield* TestClock.adjust("30 seconds");
          yield* Fiber.join(reads);
          yield* Queue.take(probes.finished);
        }),
    );
    expect(value._tag).toBe("Success");
    expect(refreshes).toEqual(["codex"]);
  }),
);

it.effect("a provider probe that outlives the interval is not started again until it ends", () =>
  Effect.gen(function* () {
    const { value, refreshes } = yield* run(
      { providers: staleCodex(), probe: () => Effect.sleep("20 minutes") },
      (service, probes) =>
        Effect.gen(function* () {
          yield* service.read(scope, { local: true });
          yield* Queue.take(probes.started);
          yield* TestClock.adjust("6 minutes");
          yield* service.read(scope, { local: true });
          yield* TestClock.adjust("6 minutes");
          yield* service.read(scope, { local: true });
          const whileRunning = probes.count();
          yield* TestClock.adjust("8 minutes");
          yield* Queue.take(probes.finished);
          yield* TestClock.adjust("5 minutes");
          yield* service.read(scope, { local: true });
          yield* Queue.take(probes.started);
          return whileRunning;
        }),
    );
    expect(value._tag === "Success" && value.success).toBe(1);
    expect(refreshes).toEqual(["codex", "codex"]);
  }),
);

it.effect("status reads still refresh quota at the default pace when periodic checks are off", () =>
  Effect.gen(function* () {
    const { value, refreshes } = yield* run(
      {
        providers: staleCodex(),
        settings: {
          backgroundActivity: {
            profile: "custom",
            baseProfile: "balanced",
            overrides: { providerHealthRefreshInterval: Duration.zero },
          },
        },
      },
      (service, probes) =>
        Effect.gen(function* () {
          yield* service.read(scope, { local: true });
          yield* Queue.take(probes.started);
          yield* Queue.take(probes.finished);
          yield* TestClock.adjust("1 minute");
          yield* service.read(scope, { local: true });
          const afterOneMinute = probes.count();
          yield* TestClock.adjust("4 minutes");
          yield* service.read(scope, { local: true });
          yield* Queue.take(probes.started);
          return afterOneMinute;
        }),
    );
    expect(value._tag === "Success" && value.success).toBe(1);
    expect(refreshes).toEqual(["codex", "codex"]);
  }),
);

it.effect(
  "a provider probe that crashes leaves reads working and the next probe free to start",
  () =>
    Effect.gen(function* () {
      let probes = 0;
      const { value, refreshes } = yield* run(
        {
          providers: staleCodex(),
          probe: () => (++probes === 1 ? Effect.die("probe crashed") : Effect.void),
        },
        (service, signals) =>
          Effect.gen(function* () {
            const first = yield* service.read(scope, { local: true });
            yield* Queue.take(signals.finished);
            yield* TestClock.adjust("5 minutes");
            yield* service.read(scope, { local: true });
            yield* Queue.take(signals.started);
            yield* Queue.take(signals.started);
            return first;
          }),
      );
      expect(value._tag).toBe("Success");
      if (value._tag !== "Success") return;
      expect(value.success.hosts[0]?.metrics?.quotas[0]?.limits.checkedAt).toBe(
        "2026-10-12T15:00:00.000Z",
      );
      expect(refreshes).toEqual(["codex", "codex"]);
    }),
);

it.effect("stopping the server interrupts a provider probe a status read started", () =>
  Effect.gen(function* () {
    const { value, interrupted } = yield* run(
      { providers: staleCodex(), probe: () => Effect.sleep("1 hour") },
      (service, probes) =>
        service.read(scope, { local: true }).pipe(Effect.andThen(Queue.take(probes.started))),
    );
    expect(value._tag).toBe("Success");
    expect(interrupted).toBe(true);
  }),
);

const installed = {
  installed: true,
  binaries: [{ path: "/fixture/ocx", version: "2.86.0" }],
  ownership: "none" as const,
  service: { available: false },
  runtime: { port: 10100, healthy: false, ready: false },
  link: { role: "none" as const, available: false, links: [], childSettingsApplied: null },
};

it.effect("the first timed-out caller leaves one inventory read running until it completes", () =>
  Effect.gen(function* () {
    const started = yield* Queue.unbounded<void>();
    let calls = 0;
    let interrupted = false;
    const { value } = yield* run(
      {
        opencodexRead: Effect.suspend(() => {
          calls++;
          return Queue.offer(started, undefined).pipe(
            Effect.andThen(Effect.sleep("27 seconds")),
            Effect.as(installed),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          );
        }),
      },
      (service) =>
        Effect.gen(function* () {
          const first = yield* service
            .read(scope, { local: true })
            .pipe(Effect.timeoutOption("10 seconds"), Effect.forkChild);
          yield* Queue.take(started);
          const concurrent = yield* service
            .read(scope, { local: true })
            .pipe(Effect.timeoutOption("10 seconds"), Effect.forkChild);
          yield* TestClock.adjust("10 seconds");
          expect(Option.isNone(yield* Fiber.join(first))).toBe(true);
          expect(Option.isNone(yield* Fiber.join(concurrent))).toBe(true);
          expect(interrupted).toBe(false);
          yield* TestClock.adjust("17 seconds");
          return yield* service.read(scope, { local: true });
        }),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    expect(value.success.hosts[0]?.metrics?.opencodex).toEqual(installed);
    expect(calls).toBe(1);
    expect(interrupted).toBe(false);
  }),
);

it.effect("a slow refresh returns the last snapshot and keeps the late answer", () =>
  Effect.gen(function* () {
    const started = yield* Queue.unbounded<void>();
    const newer = { ...installed, binaries: [{ path: "/fixture/new", version: "2.99.0" }] };
    let calls = 0;
    const { value } = yield* run(
      {
        opencodexRead: Effect.suspend(() =>
          ++calls === 1
            ? Effect.succeed(installed)
            : Queue.offer(started, undefined).pipe(
                Effect.andThen(Effect.sleep("27 seconds")),
                Effect.as(newer),
              ),
        ),
      },
      (service) =>
        Effect.gen(function* () {
          yield* service.read(scope, { local: true });
          const refresh = yield* Effect.forkChild(service.read(scope, { local: true }));
          yield* Queue.take(started);
          yield* TestClock.adjust("2 seconds");
          const stale = yield* Fiber.join(refresh);
          yield* TestClock.adjust("25 seconds");
          const fresh = yield* service.read(scope, { local: true });
          return { stale, fresh };
        }),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    expect(value.success.stale.hosts[0]?.metrics?.opencodex).toEqual({ ...installed, slow: true });
    expect(value.success.fresh.hosts[0]?.metrics?.opencodex).toEqual(newer);
    expect(calls).toBe(2);
  }),
);

it.effect("a failed refresh retains the last successful inventory", () =>
  Effect.gen(function* () {
    let calls = 0;
    const { value } = yield* run(
      {
        opencodexRead: Effect.suspend(() =>
          ++calls === 2 ? Effect.die("failed") : Effect.succeed(installed),
        ),
      },
      (service) =>
        Effect.gen(function* () {
          yield* service.read(scope, { local: true });
          const failed = yield* service.read(scope, { local: true });
          const next = yield* service.read(scope, { local: true });
          return { failed, next };
        }),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    expect(value.success.failed.hosts[0]?.metrics?.opencodex).toEqual({ ...installed, slow: true });
    expect(value.success.next.hosts[0]?.metrics?.opencodex).toEqual(installed);
    expect(calls).toBe(3);
  }),
);

it.effect("a failed first inventory read is not stored as an answer", () =>
  Effect.gen(function* () {
    let calls = 0;
    const { value } = yield* run(
      {
        opencodexRead: Effect.suspend(() =>
          ++calls === 1 ? Effect.die("failed") : Effect.succeed(installed),
        ),
      },
      (service) =>
        Effect.gen(function* () {
          const failed = yield* Effect.exit(service.read(scope, { local: true }));
          const next = yield* service.read(scope, { local: true });
          return { failed, next };
        }),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    expect(Exit.isFailure(value.success.failed)).toBe(true);
    expect(value.success.next.hosts[0]?.metrics?.opencodex).toEqual(installed);
    expect(calls).toBe(2);
  }),
);

it.effect("stopping the service interrupts an inventory read in flight", () =>
  Effect.gen(function* () {
    const started = yield* Queue.unbounded<void>();
    let interrupted = false;
    const { value } = yield* run(
      {
        opencodexRead: Queue.offer(started, undefined).pipe(
          Effect.andThen(Effect.sleep("1 hour")),
          Effect.as(installed),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        ),
      },
      (service) =>
        Effect.gen(function* () {
          yield* Effect.forkChild(service.read(scope, { local: true }));
          yield* Queue.take(started);
        }),
    );
    expect(value._tag).toBe("Success");
    expect(interrupted).toBe(true);
  }),
);
