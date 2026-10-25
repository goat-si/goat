import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NetAddress from "effect/net/NetAddress";
import * as HttpServer from "effect/http/HttpServer";
import { vi } from "vite-plus/test";
import * as TestClock from "effect/testing/TestClock";
import type { RelayManagedEndpointRuntimeConfig } from "@goat/contracts/relay";
import { RelayRequestError } from "./relayResponse.ts";
import * as AutomationHold from "../automationHold.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as ServerConfig from "../config.ts";
import * as CloudLink from "./CloudLink.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import { desiredLinkReconcileStartup } from "./DesiredLinkReconcile.ts";
import { SERVICE_STATE_FILE, SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

import {
  makeManagedTunnelRecovery,
  retryDesiredLinkReconcile,
  retryManagedTunnelRegistration,
} from "./managedTunnelStartup.ts";

describe("retryManagedTunnelRegistration", () => {
  it.effect("does not fall back or retry when registration is permanently rejected", () =>
    Effect.gen(function* () {
      let attempts = 0;
      let fallbacks = 0;
      const error = yield* Effect.flip(
        retryManagedTunnelRegistration(
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail("not authorized");
          }),
          () => false,
          Effect.sync(() => {
            fallbacks += 1;
          }),
        ),
      );
      expect(error).toBe("not authorized");
      expect(attempts).toBe(1);
      expect(fallbacks).toBe(0);
    }),
  );
});

const recoveryConfig: RelayManagedEndpointRuntimeConfig = {
  providerKind: "t3_relay",
  connectorToken: "test-token",
};

it.layer(NodeServices.layer)("held desired link lifecycle", (it) => {
  it.effect(
    "held: no tunnel restore, registration or shutdown DELETE; release: lifecycle resumes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-held-cloud-" });
        yield* fs.makeDirectory(`${baseDir}/runtime`);
        yield* fs.writeFileString(
          `${baseDir}/runtime/${SERVICE_STATE_FILE}`,
          JSON.stringify({
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "0.1.0",
            update: {
              id: "held-update",
              fromVersion: "0.1.0",
              targetVersion: "0.1.1",
              dbPath: `${baseDir}/state.sqlite`,
              status: "pending",
            },
          }),
        );
        const hold = yield* AutomationHold.makeInMemory({
          reason: "channel-copy",
          heldAt: "2026-10-25T00:00:00.000Z",
        });
        const calls: string[] = [];
        const reconciled = yield* Deferred.make<void>();
        const recovered = yield* Deferred.make<void>();
        const recoveryRequests = yield* Queue.unbounded<RelayManagedEndpointRuntimeConfig>();
        const build = Effect.fn("HeldDesiredLinkTest.build")(function* () {
          const parked = yield* Deferred.make<void>();
          const scope = yield* Scope.make();
          const startup = desiredLinkReconcileStartup(parked);
          yield* Layer.buildWithScope(startup.layer, scope).pipe(
            Effect.provideService(AutomationHold.AutomationHold, hold),
            Effect.provideService(ServerActivation.ServerActivation, Effect.void),
            Effect.provide([
              Layer.mock(CloudLink.CloudLink)({
                releaseManagedTunnelOnShutdown: () =>
                  Effect.sync(() => {
                    calls.push("delete");
                    return true;
                  }),
                startManagedTunnelIfOriginConfirmed: () =>
                  Effect.sync(() => {
                    calls.push("restore");
                    return true;
                  }),
                registerManagedTunnelRecovery: () =>
                  Effect.sync(() => calls.push("register")).pipe(
                    Effect.as({ status: "not_linked" as const }),
                  ),
                recoverManagedTunnel: () =>
                  Effect.sync(() => calls.push("recover")).pipe(
                    Effect.andThen(Deferred.succeed(recovered, undefined)),
                    Effect.as(true),
                  ),
                reconcileDesiredLinkIfStillDesired: () =>
                  Effect.sync(() => calls.push("reconcile")).pipe(
                    Effect.andThen(Deferred.succeed(reconciled, undefined)),
                    Effect.as(null),
                  ),
              }),
              Layer.mock(ServerSecretStore.ServerSecretStore)({
                get: () => Effect.succeed(Option.some(new TextEncoder().encode("managed"))),
              }),
              Layer.mock(ManagedEndpointRuntime.CloudManagedEndpointRuntime)({
                recoveryRequests: Stream.fromQueue(recoveryRequests),
              }),
              Layer.mock(HttpServer.HttpServer)({
                address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
              }),
              ServerConfig.layerTest(process.cwd(), baseDir),
            ]),
          );
          yield* Effect.all(startup.awaitParked);
          return scope;
        });
        const stoppedWhileHeld = yield* build();
        yield* Scope.close(stoppedWhileHeld, Exit.void);
        expect(calls).toEqual([]);
        yield* Queue.offer(recoveryRequests, recoveryConfig);
        const resumed = yield* build();
        yield* TestClock.adjust("0 millis");
        expect(calls).toEqual([]);
        yield* hold.release;
        yield* Deferred.await(reconciled);
        yield* Deferred.await(recovered);
        expect(calls).toContain("recover");
        expect(calls).toContain("restore");
        expect(calls).toContain("register");
        expect(calls).toContain("reconcile");
        yield* Scope.close(resumed, Exit.void);
        expect(calls.filter((call) => call === "delete")).toHaveLength(1);
      }),
  );
});

describe("managed tunnel recovery backoff", () => {
  it.effect("runs the first request immediately and doubles repeated-request cooldowns", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const recover = yield* makeManagedTunnelRecovery({
        recover: () => Effect.sync(() => ++attempts),
        isRetryable: () => false,
      });
      yield* recover(recoveryConfig);
      expect(attempts).toBe(1);
      const second = yield* Effect.forkChild(recover(recoveryConfig));
      yield* TestClock.adjust("3 minutes");
      expect(attempts).toBe(1);
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(second);
      expect(attempts).toBe(2);
      const third = yield* Effect.forkChild(recover(recoveryConfig));
      yield* TestClock.adjust("7 minutes");
      expect(attempts).toBe(2);
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(third);
      expect(attempts).toBe(3);
      yield* TestClock.adjust("18 minutes");
      yield* recover(recoveryConfig);
      expect(attempts).toBe(4);
    }),
  );

  it.effect("honors relay Retry-After during recovery retries", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const recover = yield* makeManagedTunnelRecovery({
        recover: () =>
          Effect.suspend(() =>
            ++attempts === 1
              ? Effect.fail(
                  new RelayRequestError({
                    rejection: "unavailable",
                    description: "relay offline",
                    retryAfterMillis: 300_000,
                  }),
                )
              : Effect.succeed(true),
          ),
        isRetryable: () => true,
      });
      const fiber = yield* Effect.forkChild(recover(recoveryConfig));
      yield* TestClock.adjust("4 minutes");
      expect(attempts).toBe(1);
      yield* TestClock.adjust("1 minute");
      expect(yield* Fiber.join(fiber)).toBe(true);
      expect(attempts).toBe(2);
    }),
  );
});

describe("desired link reconciliation retry window", () => {
  it.effect(
    "keeps retrying an unavailable relay after the window without ignoring Retry-After",
    () =>
      Effect.gen(function* () {
        let attempts = 0;
        let warnings = 0;
        const exhausted = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          retryDesiredLinkReconcile(
            Effect.suspend(() =>
              ++attempts <= 2
                ? Effect.fail(
                    new RelayRequestError({
                      rejection: "unavailable",
                      description: "relay offline",
                      retryAfterMillis: 900_000,
                    }),
                  )
                : Effect.succeed("managed"),
            ),
            () => true,
            () =>
              Effect.sync(() => {
                warnings += 1;
              }).pipe(Effect.andThen(Deferred.succeed(exhausted, undefined)), Effect.asVoid),
          ),
        );
        yield* Deferred.await(exhausted);
        expect(attempts).toBe(1);
        yield* TestClock.adjust("14 minutes");
        expect(attempts).toBe(1);
        yield* TestClock.adjust("1 minute");
        expect(attempts).toBe(2);
        yield* TestClock.adjust("15 minutes");
        expect(yield* Fiber.join(fiber)).toBe("managed");
        expect(attempts).toBe(3);
        expect(warnings).toBe(1);
      }),
  );

  it.effect("stops retrying a local runtime failure at the window", () =>
    Effect.gen(function* () {
      let attempts = 0;
      let warnings = 0;
      const failure = {
        _tag: "LocalRuntimeError",
        cause: new RelayRequestError({
          rejection: "unavailable",
          description: "retry hint",
          retryAfterMillis: 900_000,
        }),
      };
      const fiber = yield* Effect.forkChild(
        retryDesiredLinkReconcile(
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail(failure);
          }),
          () => true,
          () =>
            Effect.sync(() => {
              warnings += 1;
            }),
        ).pipe(Effect.flip),
      );
      yield* TestClock.adjust("15 minutes");
      expect(yield* Fiber.join(fiber)).toBe(failure);
      expect(attempts).toBe(1);
      expect(warnings).toBe(0);
    }),
  );
});

vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));

vi.mock("./publicConfig.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./publicConfig.ts")>()),
  hasCloudPublicConfig: true,
}));
