import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Path from "effect/Path";
import * as HostProcess from "@goat/shared/HostProcess";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import * as RuntimeAdmission from "../runtimeAdmission.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ServerSelfUpdateError } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as HttpClientError from "effect/http/HttpClientError";
import { TestClock } from "effect/testing";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import * as SshRuntimeAutoUpdate from "./sshRuntimeAutoUpdate.ts";
import type { ServiceUpdateRecord } from "./serviceProtocol.ts";
import * as AutoUpdate from "./autoUpdate.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const publishedAt = "2026-10-01T00:00:00Z";
const published = Date.parse(publishedAt);
const stable = "1.1.0";
const nightly = "1.1.0-nightly.20261001.2";
const release = (version: string, date: string | undefined = publishedAt) => ({
  tag_name: `v${version}`,
  ...(date === undefined ? {} : { published_at: date }),
});

it.each(["stable", "nightly"] as const)(
  "rollout %s includes bucket edges exactly at the deadline",
  (channel) => {
    for (const bucket of [0, 99]) {
      const deadline =
        published +
        (channel === "stable" ? 48 : 0) * HOUR +
        (bucket / 100) * (channel === "stable" ? 72 : 12) * HOUR;
      expect(
        AutoUpdate.isRolloutEligible({ channel, bucket, publishedAt, now: deadline - 1 }),
      ).toBe(false);
      expect(AutoUpdate.isRolloutEligible({ channel, bucket, publishedAt, now: deadline })).toBe(
        true,
      );
      expect(
        AutoUpdate.isRolloutEligible({ channel, bucket, publishedAt, now: deadline + 1 }),
      ).toBe(true);
    }
  },
);

it("stable soaks for 48 hours while nightly has no soak", () => {
  expect(
    AutoUpdate.isRolloutEligible({
      channel: "stable",
      bucket: 0,
      publishedAt,
      now: published + 48 * HOUR - 1,
    }),
  ).toBe(false);
  expect(
    AutoUpdate.isRolloutEligible({
      channel: "nightly",
      bucket: 99,
      publishedAt,
      now: published + 12 * HOUR,
    }),
  ).toBe(true);
});

it.each([undefined, "", "invalid-date"])("never rolls out a release with date %s", (date) => {
  for (const channel of ["stable", "nightly"] as const) {
    expect(
      AutoUpdate.isRolloutEligible({
        channel,
        bucket: 0,
        publishedAt: date,
        now: published + 1_000 * HOUR,
      }),
    ).toBe(false);
  }
});

it.effect("uses the first four SHA256 bytes with a colon separator", () =>
  Effect.gen(function* () {
    // SHA256('env:1.1.0') starts with 4d87eb7e, whose uint32 big endian value is bucket 78.
    expect(yield* AutoUpdate.rolloutBucket("env", "1.1.0")).toBe(78);
    expect(yield* AutoUpdate.rolloutBucket("env", "1.1.0")).not.toBe(
      yield* AutoUpdate.rolloutBucket("env", "1.1.1"),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

const makeHarness = Effect.fn("test.auto_update.harness")(function* (
  options: {
    readonly ownVersion?: string;
    readonly capability?: "boot-service" | "desktop-managed" | null;
    readonly lastUpdate?: ServiceUpdateRecord;
    readonly activated?: boolean;
    /** Run as a client-launched SSH runtime instead of under the service launcher. */
    readonly sshRuntime?: boolean;
    readonly sshRuntimeService?: SshRuntimeAutoUpdate.SshRuntimeAutoUpdate["Service"];
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-auto-update-" });
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );
  const events = yield* Queue.unbounded<ReadonlyArray<unknown>>();
  const requests = yield* Queue.unbounded<number>();
  const logs: ReadonlyArray<unknown>[] = [];
  const state = {
    enabled: true,
    updating: false,
    busy: false,
    failedPreparation: false,
    activationError: false,
    reply: "ok" as "ok" | "invalid" | "network",
    releases: [release("99.0.0-preview.20261001.9"), release(nightly), release(stable)],
    requests: 0,
    prepared: [] as string[],
    updates: [] as Parameters<ServerSelfUpdate.ServerSelfUpdate["Service"]["update"]>[],
    sshOwned: true,
    sshBusy: false,
    sshFailedTarget: undefined as string | undefined,
    sshActivations: [] as string[],
    sshCleared: 0,
  };
  const prepareStarted = yield* Deferred.make<void>();
  const preparationGate = yield* Deferred.make<void>();
  let holdPreparation = false;
  const prepare = (targetVersion: string) =>
    Effect.gen(function* () {
      state.prepared.push(targetVersion);
      yield* Deferred.succeed(prepareStarted, undefined);
      if (holdPreparation) yield* Deferred.await(preparationGate);
      if (state.failedPreparation)
        return yield* new ServerSelfUpdateError({ reason: "checksum mismatch" });
    });
  const sshRuntime = SshRuntimeAutoUpdate.SshRuntimeAutoUpdate.of({
    supported: options.sshRuntime === true,
    owned: Effect.sync(() => state.sshOwned),
    isUpdating: Effect.sync(() => state.updating),
    failedTarget: Effect.sync(() => state.sshFailedTarget),
    prepare,
    activate: (targetVersion) =>
      Effect.sync(() => {
        state.sshActivations.push(targetVersion);
        return state.sshBusy ? ("busy" as const) : ("requested" as const);
      }),
    clearPending: Effect.sync(() => {
      state.sshCleared++;
    }),
    admitDrain: () => Effect.succeed(true),
  });
  const selfUpdate = ServerSelfUpdate.ServerSelfUpdate.of({
    capability:
      options.sshRuntime === true
        ? null
        : options.capability === undefined
          ? "boot-service"
          : options.capability,
    isUpdating: Effect.sync(() => state.updating),
    prepare,
    update: (...args) =>
      Effect.gen(function* () {
        state.updates.push(args);
        if (state.busy)
          return yield* new ServerSelfUpdateError({
            reason: ServerSelfUpdate.SERVER_UPDATE_BUSY_REASON,
          });
        if (state.activationError)
          return yield* new ServerSelfUpdateError({ reason: "launcher unavailable" });
        state.updating = true;
        return {
          method: "boot-service" as const,
          targetVersion: args[0].targetVersion,
          updateId: "update-1",
        };
      }),
    commitDesktopUpdate: () => Effect.never,
  });
  const httpClient = HttpClient.make((request) =>
    Effect.gen(function* () {
      state.requests++;
      yield* Queue.offer(requests, state.requests);
      if (state.reply === "network")
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: new Error("offline") }),
        });
      return HttpClientResponse.fromWeb(
        request,
        Response.json(state.reply === "invalid" ? { bad: true } : state.releases),
      );
    }),
  );
  const logger = Logger.make(({ message }) => {
    const parts: ReadonlyArray<unknown> = Array.isArray(message) ? message : [message];
    logs.push(parts);
    Queue.offerUnsafe(events, parts);
  });
  const autoUpdate = yield* AutoUpdate.make({ ownVersion: options.ownVersion ?? "1.0.0" }).pipe(
    Effect.provideService(ServerSelfUpdate.ServerSelfUpdate, selfUpdate),
    Effect.provideService(
      SshRuntimeAutoUpdate.SshRuntimeAutoUpdate,
      options.sshRuntimeService ?? sshRuntime,
    ),
    Effect.provideService(ServiceLauncherClient.ServiceLauncherClient, {
      managed: true,
      ...(options.lastUpdate === undefined ? {} : { lastUpdate: options.lastUpdate }),
      requestUpdate: () => Effect.die("scheduler bypassed self-update"),
      prepareTrial: Effect.undefined,
    }),
    Effect.provide(
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.sync(() => ({
          ...DEFAULT_SERVER_SETTINGS,
          automaticServerUpdates: state.enabled,
        })),
      }),
    ),
    Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env")),
    }),
    Effect.provideService(ServerConfig.ServerConfig, config),
    Effect.provideService(HttpClient.HttpClient, httpClient),
  );
  const activation = yield* Deferred.make<void>();
  if (options.activated !== false) yield* Deferred.succeed(activation, undefined);
  const fiber = yield* ServerActivation.forkParkedFiber(
    autoUpdate.run.pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false }))),
  ).pipe(Effect.provideService(ServerActivation.ServerActivation, Deferred.await(activation)));
  const awaitEvent = Effect.fn("test.auto_update.await_event")(function* (name: string) {
    while (true) {
      const event = yield* Queue.take(events);
      if (event[0] === `server.auto_update.${name}`) return event;
    }
  });
  return {
    state,
    logs,
    fiber,
    activation,
    awaitEvent,
    awaitRequest: Queue.take(requests),
    prepareStarted,
    preparationGate,
    holdPreparation: () => {
      holdPreparation = true;
    },
  };
});

it.layer(NodeServices.layer)("server auto-update", (it) => {
  // quarantine: #612 This case reaches native Windows compiler startup, not a platform mock.
  it.effect.skipIf(HostProcess.Platform.defaultValue() !== "win32")(
    "retries activation compiler failure at the next six-hour check without losing the scheduler",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-scheduler-compiler-" });
        const config = yield* ServerConfig.ServerConfig.pipe(
          Effect.provide(ServerConfig.layerTest(process.cwd(), path.join(home, ".goat"))),
        );
        const native = yield* SshRuntimeAutoUpdate.SshRuntimeHost.pipe(
          Effect.provide(SshRuntimeAutoUpdate.layerHost),
        );
        const memory = yield* ProjectionStore.ProjectionStoreV2.pipe(
          Effect.provide(ProjectionStore.layerMemory),
        );
        const admission = yield* RuntimeAdmission.RuntimeAdmission.pipe(
          Effect.provide(RuntimeAdmission.layer),
        );
        let attempts = 0;
        const runtime = yield* SshRuntimeAutoUpdate.make({
          ownVersion: "1.0.0",
          homeDir: home,
          pid: 4242,
          platform: "win32",
          resolveGitBash: () => Effect.succeed("C:\\Program Files\\Git\\bin\\bash.exe"),
        }).pipe(
          Effect.provideService(ServerConfig.ServerConfig, config),
          Effect.provideService(RuntimeAdmission.RuntimeAdmission, admission),
          Effect.provideService(ProjectionStore.ProjectionStoreV2, {
            ...memory,
            getServerActivity: () => Effect.succeed("idle" as const),
          }),
          Effect.provide(
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.succeed({
                ...DEFAULT_SERVER_SETTINGS,
                automaticServerUpdates: true,
              }),
            }),
          ),
          Effect.provideService(SshRuntimeAutoUpdate.SshRuntimeHost, {
            ...native,
            readText: (file) =>
              Effect.succeed(
                file.endsWith("last-replacement.json")
                  ? undefined
                  : file.endsWith(".install-complete")
                    ? stable
                    : file.endsWith(".install-record")
                      ? `${stable} archive-sha exe-sha https`
                      : file.endsWith("managed")
                        ? "managed"
                        : file.endsWith("pid")
                          ? "4242"
                          : "runner",
              ),
            sha256: () => Effect.succeed("exe-sha"),
            run: (input) =>
              Effect.succeed({
                code: 0,
                stderr: "",
                stdout:
                  input.args[0] === "-s"
                    ? `goat v${stable}`
                    : input.args[0] === "__ssh-helper"
                      ? `${stable} ${SSH_RUNTIME_PROTOCOL_VERSION} ${ORCHESTRATION_PROTOCOL_VERSION} 0 0`
                      : JSON.stringify({ status: "ready", version: stable, launcherProtocol: 3 }),
              }),
            runDetached: (input) =>
              Effect.suspend(() => {
                attempts++;
                return native.runDetached({
                  ...input,
                  env: { ...input.env, SystemRoot: path.join(home, "missing-windows") },
                });
              }),
          }),
        );
        yield* TestClock.setTime(published + 10 * 24 * HOUR);
        const h = yield* makeHarness({ sshRuntime: true, sshRuntimeService: runtime });
        const failure = h
          .awaitEvent("failed")
          .pipe(
            Effect.raceFirst(
              Fiber.join(h.fiber).pipe(Effect.andThen(Effect.die("scheduler terminated"))),
            ),
          );
        yield* TestClock.adjust(10 * MINUTE);
        expect((yield* failure)[1]).toMatchObject({ stage: "activation" });
        expect(attempts).toBe(1);
        expect(yield* runtime.isUpdating).toBe(false);
        yield* TestClock.adjust(6 * HOUR - 1);
        expect(attempts).toBe(1);
        yield* TestClock.adjust(1);
        expect((yield* failure)[1]).toMatchObject({ stage: "activation" });
        expect(attempts).toBe(2);
        expect(yield* runtime.isUpdating).toBe(false);
      }),
  );

  it.effect(
    "waits for activation, then ten minutes, and requests an unconfirmed update with its actor",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(published + 10 * 24 * HOUR);
        const h = yield* makeHarness({ activated: false });
        yield* TestClock.adjust(24 * HOUR);
        expect(h.state.requests).toBe(0);
        yield* Deferred.succeed(h.activation, undefined);
        yield* TestClock.adjust(10 * MINUTE - 1);
        expect(h.state.requests).toBe(0);
        yield* TestClock.adjust(1);
        yield* h.awaitEvent("requested");
        expect(h.state.prepared).toEqual([stable]);
        expect(h.state.updates).toEqual([
          [{ targetVersion: stable }, undefined, undefined, { kind: "auto-update" }],
        ]);
        expect(h.logs.map((event) => event[0])).toEqual([
          "server.auto_update.checked",
          "server.auto_update.prepared",
          "server.auto_update.requested",
        ]);
      }),
  );

  it.effect.each(["desktop-managed", null] as const)("never runs on capability %s", (capability) =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ capability });
      yield* Fiber.join(h.fiber);
      yield* TestClock.adjust(12 * HOUR);
      expect(h.state.requests).toBe(0);
      expect(h.state.prepared).toEqual([]);
      expect(h.state.updates).toEqual([]);
    }),
  );

  it.effect.each(["1.0.0-dev.123.gabc", "1.0.0-pr.123.1", "1.0.0-preview.20261001.1"])(
    "never updates own build %s",
    (ownVersion) =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ ownVersion });
        yield* Fiber.join(h.fiber);
        yield* TestClock.adjust(12 * HOUR);
        expect(h.state.requests).toBe(0);
        expect(h.state.updates).toEqual([]);
      }),
  );

  it.effect.each([
    { ownVersion: "1.0.0", target: stable },
    { ownVersion: "1.0.0-nightly.20260930.1", target: nightly },
  ] as const)(
    "$ownVersion follows only its own channel despite a newer preview",
    ({ ownVersion, target }) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(published + 10 * 24 * HOUR);
        const h = yield* makeHarness({ ownVersion });
        yield* TestClock.adjust(10 * MINUTE);
        yield* h.awaitEvent("requested");
        expect(h.state.prepared).toEqual([target]);
        expect(h.state.updates[0]?.[0].targetVersion).toBe(target);
      }),
  );

  it.effect("does no discovery or preparation when disabled and observes later opt-in", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(published + 10 * 24 * HOUR);
      const h = yield* makeHarness();
      h.state.enabled = false;
      yield* TestClock.adjust(10 * MINUTE);
      expect((yield* h.awaitEvent("skipped"))[1]).toMatchObject({ reason: "disabled" });
      expect(h.state.requests).toBe(0);
      h.state.enabled = true;
      yield* TestClock.adjust(6 * HOUR);
      yield* h.awaitEvent("requested");
      expect(h.state.prepared).toEqual([stable]);
    }),
  );

  it.effect.each(["1.0.0", "0.9.0"])("refuses target %s that is not strictly newer", (target) =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.state.releases = [release(target)];
      yield* TestClock.adjust(10 * MINUTE);
      expect((yield* h.awaitEvent("skipped"))[1]).toMatchObject({ reason: "not-newer" });
      expect(h.state.prepared).toEqual([]);
      expect(h.state.updates).toEqual([]);
    }),
  );

  it.effect.each(["failed", "rolled-back"] as const)(
    "skips the launcher's last %s target",
    (status) =>
      Effect.gen(function* () {
        const h = yield* makeHarness({
          lastUpdate: { id: "failed-1", fromVersion: "1.0.0", targetVersion: stable, status },
        });
        h.state.releases = [release(stable), release("1.0.1")];
        yield* TestClock.adjust(10 * MINUTE);
        expect((yield* h.awaitEvent("skipped"))[1]).toMatchObject({
          reason: "previous-failure",
        });
        expect(h.state.prepared).toEqual([]);
      }),
  );

  it.effect("allows a different target after a launcher failure", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(published + 10 * 24 * HOUR);
      const h = yield* makeHarness({
        lastUpdate: {
          id: "failed-1",
          fromVersion: "1.0.0",
          targetVersion: "1.0.1",
          status: "failed",
        },
      });
      yield* TestClock.adjust(10 * MINUTE);
      yield* h.awaitEvent("requested");
      expect(h.state.prepared).toEqual([stable]);
    }),
  );

  it.effect.each(["missing", "invalid", "soaking"])(
    "does not prepare a release whose publication is %s",
    (date) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(published);
        const h = yield* makeHarness();
        h.state.releases =
          date === "missing"
            ? [{ tag_name: `v${stable}` }]
            : [release(stable, date === "invalid" ? "bad-date" : publishedAt)];
        yield* TestClock.adjust(10 * MINUTE);
        expect((yield* h.awaitEvent("skipped"))[1]).toMatchObject({
          reason: "rollout-not-eligible",
        });
        expect(h.state.prepared).toEqual([]);
      }),
  );

  it.effect("checks every six hours after the first check", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.state.releases = [release("1.0.0")];
      yield* TestClock.adjust(10 * MINUTE);
      yield* h.awaitEvent("skipped");
      yield* TestClock.adjust(6 * HOUR - 1);
      expect(h.state.requests).toBe(1);
      yield* TestClock.adjust(1);
      yield* h.awaitEvent("skipped");
      expect(h.state.requests).toBe(2);
    }),
  );

  it.effect(
    "busy activation retries every ten minutes without another prepare or release request",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(published + 10 * 24 * HOUR);
        const h = yield* makeHarness();
        h.state.busy = true;
        yield* TestClock.adjust(10 * MINUTE);
        yield* h.awaitEvent("deferred-busy");
        yield* TestClock.adjust(10 * MINUTE - 1);
        expect(h.state.updates).toHaveLength(1);
        yield* TestClock.adjust(1);
        yield* h.awaitEvent("deferred-busy");
        h.state.busy = false;
        yield* TestClock.adjust(10 * MINUTE);
        yield* h.awaitEvent("requested");
        expect(h.state.requests).toBe(1);
        expect(h.state.prepared).toEqual([stable]);
        expect(h.state.updates).toHaveLength(3);
        for (const [input] of h.state.updates) expect(input.confirmReplacement).toBeUndefined();
      }),
  );

  it.effect("busy retries start ten minutes after a long preparation finishes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(published + 10 * 24 * HOUR);
      const h = yield* makeHarness();
      h.holdPreparation();
      h.state.busy = true;
      yield* TestClock.adjust(10 * MINUTE);
      yield* Deferred.await(h.prepareStarted);
      yield* TestClock.adjust(31 * MINUTE);
      yield* Deferred.succeed(h.preparationGate, undefined);
      yield* h.awaitEvent("deferred-busy");
      yield* TestClock.adjust(10 * MINUTE - 1);
      expect(h.state.updates).toHaveLength(1);
      yield* TestClock.adjust(1);
      yield* h.awaitEvent("deferred-busy");
      expect(h.state.updates).toHaveLength(2);
      expect(h.state.prepared).toEqual([stable]);
    }),
  );

  it.effect("a non-busy activation failure waits for the next six-hour check", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(published + 10 * 24 * HOUR);
      const h = yield* makeHarness();
      h.state.activationError = true;
      yield* TestClock.adjust(10 * MINUTE);
      yield* h.awaitEvent("failed");
      yield* TestClock.adjust(10 * MINUTE);
      expect(h.state.updates).toHaveLength(1);
      h.state.activationError = false;
      yield* TestClock.adjust(6 * HOUR - 10 * MINUTE);
      yield* h.awaitEvent("requested");
      expect(h.state.updates).toHaveLength(2);
    }),
  );

  it.effect("a manual update in flight suppresses a prepared target's busy retry", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(published + 10 * 24 * HOUR);
      const h = yield* makeHarness();
      h.state.busy = true;
      yield* TestClock.adjust(10 * MINUTE);
      yield* h.awaitEvent("deferred-busy");
      h.state.updating = true;
      yield* TestClock.adjust(10 * MINUTE);
      expect((yield* h.awaitEvent("skipped"))[1]).toMatchObject({ reason: "update-in-flight" });
      expect(h.state.updates).toHaveLength(1);
      expect(h.state.prepared).toEqual([stable]);
      h.state.updating = false;
      h.state.busy = false;
      yield* TestClock.adjust(10 * MINUTE);
      yield* h.awaitEvent("requested");
      expect(h.state.prepared).toEqual([stable]);
    }),
  );

  it.effect("disabling a prepared busy update prevents activation retries", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(published + 10 * 24 * HOUR);
      const h = yield* makeHarness();
      h.state.busy = true;
      yield* TestClock.adjust(10 * MINUTE);
      yield* h.awaitEvent("deferred-busy");
      h.state.enabled = false;
      yield* TestClock.adjust(10 * MINUTE);
      yield* h.awaitEvent("skipped");
      expect(h.state.updates).toHaveLength(1);
    }),
  );

  it.effect("does not call prepare or update while another update is in flight", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.state.updating = true;
      yield* TestClock.adjust(10 * MINUTE);
      expect((yield* h.awaitEvent("skipped"))[1]).toMatchObject({ reason: "update-in-flight" });
      expect(h.state.requests).toBe(0);
      expect(h.state.prepared).toEqual([]);
      expect(h.state.updates).toEqual([]);
    }),
  );

  it.effect("does not overlap long preparation and rechecks opt-out before activation", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(published + 10 * 24 * HOUR);
      const h = yield* makeHarness();
      h.holdPreparation();
      yield* TestClock.adjust(10 * MINUTE);
      yield* Deferred.await(h.prepareStarted);
      yield* TestClock.adjust(12 * HOUR);
      expect(h.state.prepared).toHaveLength(1);
      expect(h.state.updates).toEqual([]);
      h.state.enabled = false;
      yield* Deferred.succeed(h.preparationGate, undefined);
      yield* h.awaitEvent("skipped");
      expect(h.state.updates).toEqual([]);
    }),
  );

  it.effect.each(["invalid", "network"] as const)(
    "logs %s release discovery failures and retries at the next cadence",
    (reply) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(published + 10 * 24 * HOUR);
        const h = yield* makeHarness();
        h.state.reply = reply;
        yield* TestClock.adjust(10 * MINUTE);
        if (reply === "network") {
          expect(yield* h.awaitRequest).toBe(1);
          yield* TestClock.adjust(1_000);
          expect(yield* h.awaitRequest).toBe(2);
          yield* TestClock.adjust(2_000);
          expect(yield* h.awaitRequest).toBe(3);
        }
        yield* h.awaitEvent("failed");
        expect(h.state.prepared).toEqual([]);
        h.state.reply = "ok";
        yield* TestClock.adjust(6 * HOUR);
        yield* h.awaitEvent("requested");
        expect(h.state.prepared).toEqual([stable]);
      }),
  );

  it.effect("preparation failure never activates and retries at the next cadence", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(published + 10 * 24 * HOUR);
      const h = yield* makeHarness();
      h.state.failedPreparation = true;
      yield* TestClock.adjust(10 * MINUTE);
      yield* h.awaitEvent("failed");
      expect(h.state.updates).toEqual([]);
      h.state.failedPreparation = false;
      yield* TestClock.adjust(6 * HOUR);
      yield* h.awaitEvent("requested");
      expect(h.state.prepared).toHaveLength(2);
    }),
  );

  it.effect("an owned SSH runtime activates through its own path, never the launcher", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(published + 10 * 24 * HOUR);
      const h = yield* makeHarness({ sshRuntime: true });
      yield* TestClock.adjust(10 * MINUTE);
      yield* h.awaitEvent("requested");
      expect(h.state.prepared).toEqual([stable]);
      expect(h.state.sshActivations).toEqual([stable]);
      expect(h.state.updates).toEqual([]);
    }),
  );

  it.effect.each(["1.0.0-dev.20261001.gabc", "1.0.0-pr.123.1", "1.0.0-preview.20261001.1"])(
    "an SSH runtime on %s never checks, prepares or activates",
    (ownVersion) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(published + 10 * 24 * HOUR);
        const h = yield* makeHarness({ sshRuntime: true, ownVersion });
        yield* Fiber.join(h.fiber);
        yield* TestClock.adjust(24 * HOUR);
        expect(h.state.requests).toBe(0);
        expect(h.state.prepared).toEqual([]);
        expect(h.state.sshActivations).toEqual([]);
      }),
  );

  it.effect("an SSH runtime that no longer owns its launch records does nothing", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(published + 10 * 24 * HOUR);
      const h = yield* makeHarness({ sshRuntime: true });
      h.state.sshOwned = false;
      yield* TestClock.adjust(10 * MINUTE);
      expect((yield* h.awaitEvent("skipped"))[1]).toMatchObject({ reason: "not-replaceable" });
      expect(h.state.requests).toBe(0);
      expect(h.state.sshActivations).toEqual([]);
    }),
  );

  it.effect("a busy SSH runtime retries every ten minutes on the prepared target", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(published + 10 * 24 * HOUR);
      const h = yield* makeHarness({ sshRuntime: true });
      h.state.sshBusy = true;
      yield* TestClock.adjust(10 * MINUTE);
      yield* h.awaitEvent("deferred-busy");
      yield* TestClock.adjust(10 * MINUTE - 1);
      expect(h.state.sshActivations).toHaveLength(1);
      yield* TestClock.adjust(1);
      yield* h.awaitEvent("deferred-busy");
      h.state.sshBusy = false;
      yield* TestClock.adjust(10 * MINUTE);
      yield* h.awaitEvent("requested");
      expect(h.state.sshActivations).toEqual([stable, stable, stable]);
      expect(h.state.prepared).toEqual([stable]);
      expect(h.state.requests).toBe(1);
    }),
  );

  it.effect("an SSH runtime never retries a target its supervisor rolled back", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(published + 10 * 24 * HOUR);
      const h = yield* makeHarness({ sshRuntime: true });
      h.state.sshFailedTarget = stable;
      yield* TestClock.adjust(10 * MINUTE);
      expect((yield* h.awaitEvent("skipped"))[1]).toMatchObject({ reason: "previous-failure" });
      yield* TestClock.adjust(6 * HOUR);
      yield* h.awaitEvent("skipped");
      expect(h.state.prepared).toEqual([]);
      expect(h.state.sshActivations).toEqual([]);
      h.state.releases = [release("1.2.0")];
      yield* TestClock.adjust(6 * HOUR);
      yield* h.awaitEvent("requested");
      expect(h.state.sshActivations).toEqual(["1.2.0"]);
    }),
  );

  it.effect("opting out drops an SSH runtime's prepared target before it activates", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(published + 10 * 24 * HOUR);
      const h = yield* makeHarness({ sshRuntime: true });
      h.state.sshBusy = true;
      yield* TestClock.adjust(10 * MINUTE);
      yield* h.awaitEvent("deferred-busy");
      h.state.enabled = false;
      yield* TestClock.adjust(10 * MINUTE);
      expect((yield* h.awaitEvent("skipped"))[1]).toMatchObject({ reason: "disabled" });
      expect(h.state.sshActivations).toHaveLength(1);
      expect(h.state.sshCleared).toBe(1);
      yield* TestClock.adjust(24 * HOUR);
      expect(h.state.sshActivations).toHaveLength(1);
    }),
  );
});
