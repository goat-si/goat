import { describe, expect, it } from "@effect/vitest";
import {
  CloudMachineError,
  HubNodesError,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  type CloudMachine,
  type HubNodeImportProfile,
} from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as CloudMachineService from "../cloudMachines/CloudMachineService.ts";
import * as LinkedHosts from "../linkedHosts/LinkedHosts.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import migration from "../persistence/Migrations/095_HubNodes.ts";
import * as HubNodeRepository from "./HubNodeRepository.ts";
import * as HubNodes from "./HubNodes.ts";

const hub = EnvironmentId.make("env-hub");
const remote = EnvironmentId.make("env-box");
const at = "2026-10-19T00:00:00.000Z";
const descriptor = Schema.decodeSync(ExecutionEnvironmentDescriptor)({
  environmentId: hub,
  label: "Hub",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "test",
  capabilities: { repositoryIdentity: true },
});
const sshInput = (alias = "box") => ({
  kind: "ssh" as const,
  alias,
  hostname: null,
  username: null,
  port: null,
});
const options = { addedBy: { kind: "user" as const, at }, beforeSave: Effect.void };
const link: LinkedHosts.LinkedHost = {
  name: "linked",
  baseUrl: "https://box.example",
  environmentId: remote,
  label: "Linked box",
  serverVersion: "test",
  access: "read-only",
  linkedAt: at,
  expiresAt: at,
};
const machine = (state: CloudMachine["state"] = "archived"): CloudMachine => ({
  alias: "boat-bx_23456789",
  sandboxId: "bx_23456789",
  label: "Cloud box",
  provider: "boat",
  type: "small",
  ttlSeconds: 3600,
  presence: "present",
  state,
  deletePending: false,
  lastError: null,
});
const profile: HubNodeImportProfile = {
  environmentId: remote,
  label: "Imported box",
  ssh: { alias: "box", hostname: null, username: null, port: null },
};

const fixture = Effect.gen(function* () {
  yield* migration;
  const original = yield* HubNodeRepository.HubNodeRepository.pipe(
    Effect.provide(HubNodeRepository.layer),
  );
  const linkSignals = yield* PubSub.unbounded<void>();
  const cloudSignals = yield* PubSub.unbounded<void>();
  const listeners: Array<
    (alias: string, cause: CloudMachineService.CloudAliasInvalidation) => Effect.Effect<void>
  > = [];
  const state = {
    links: [] as LinkedHosts.LinkedHost[],
    machines: [] as CloudMachine[],
    identity: remote as EnvironmentId | null,
    identify: [] as string[],
    cloudLists: 0,
    snapshotReads: 0,
    snapshotFailure: null as "sql" | "linked" | "cloud" | null,
    onSnapshotFailure: Effect.void as Effect.Effect<void>,
    linkedIdentity: remote,
    httpCalls: [] as string[],
    httpStatus: 200,
    unlinked: [] as string[],
    beforeRead: Effect.void as Effect.Effect<void>,
    afterRead: Effect.void as Effect.Effect<void>,
    identifyEffect: undefined as
      | Effect.Effect<EnvironmentId | null, SshRemoteDispatch.SshRemoteDispatchError>
      | undefined,
  };
  const repository = HubNodeRepository.HubNodeRepository.of({
    ...original,
    listRegistrations: Effect.gen(function* () {
      state.snapshotReads++;
      yield* state.beforeRead;
      if (state.snapshotFailure === "sql") {
        yield* state.onSnapshotFailure;
        return yield* new HubNodesError({ reason: "storage_failed", detail: "Test SQL failure" });
      }
      const rows = yield* original.listRegistrations;
      const after = state.afterRead;
      state.afterRead = Effect.void;
      yield* after;
      return rows;
    }),
  });
  const linked = LinkedHosts.LinkedHosts.of({
    changes: Stream.fromPubSub(linkSignals),
    list: Effect.gen(function* () {
      if (state.snapshotFailure === "linked") {
        yield* state.onSnapshotFailure;
        return yield* new LinkedHosts.LinkedHostError({
          reason: "storage_failed",
          message: "Test link failure",
        });
      }
      return state.links;
    }),
    names: Effect.sync(() => state.links.map((entry) => entry.name)),
    find: () => Effect.succeedNone,
    link: (input) =>
      Effect.gen(function* () {
        yield* input.beforeSave;
        const exchanged = { ...descriptor, environmentId: state.linkedIdentity };
        if (input.acceptDescriptor) yield* input.acceptDescriptor(exchanged);
        const host = {
          ...link,
          name: input.name,
          access: input.access,
          environmentId: exchanged.environmentId,
        };
        const replaced = state.links.some((entry) => entry.name === input.name);
        state.links = [...state.links.filter((entry) => entry.name !== input.name), host];
        yield* PubSub.publish(linkSignals, undefined);
        return { host, replaced };
      }),
    unlink: (name) =>
      Effect.gen(function* () {
        state.unlinked.push(name);
        const found = state.links.find((entry) => entry.name === name);
        state.links = state.links.filter((entry) => entry.name !== name);
        yield* PubSub.publish(linkSignals, undefined);
        return Option.fromUndefinedOr(found);
      }),
  });
  const forbidden = () => Effect.die("Hub checks must never wake, resume, create, or launch");
  const cloud = CloudMachineService.CloudMachineService.of({
    changes: Stream.fromPubSub(cloudSignals),
    catalog: Effect.gen(function* () {
      if (state.snapshotFailure === "cloud") {
        yield* state.onSnapshotFailure;
        return yield* new CloudMachineError({ reason: "storage_failed" });
      }
      return state.machines.map(({ alias, label }) => ({ alias, label }));
    }),
    list: () =>
      Effect.sync(() => {
        state.cloudLists++;
        return { configured: true, unconfirmedCreates: 0, machines: state.machines };
      }),
    configure: forbidden,
    disconnect: forbidden,
    create: forbidden,
    stop: forbidden,
    resume: forbidden,
    delete: forbidden,
    forget: forbidden,
    dismissUnconfirmedCreates: forbidden,
    ensureReady: forbidden,
    owns: (alias) => Effect.succeed(state.machines.some((entry) => entry.alias === alias)),
    isRemoved: (alias) => Effect.succeed(!state.machines.some((entry) => entry.alias === alias)),
    onRemoving: () => Effect.void,
    onAliasInvalidated: (listener) =>
      Effect.sync(() => {
        listeners.push(listener);
      }),
    onReady: () => Effect.void,
  });
  const ssh = SshRemoteDispatch.SshRemoteDispatch.of({
    proxyEndpoint: () => Effect.die("unused"),
    issueProxySession: () => Effect.die("unused"),
    identifyTarget: (target: { alias: string }) =>
      Effect.suspend(() => {
        state.identify.push(target.alias);
        return state.identifyEffect ?? Effect.succeed(state.identity);
      }),
    preflightTarget: forbidden,
    runRemoteScript: forbidden,
    runHostScript: forbidden,
    launchThread: forbidden,
    runtimeStatus: forbidden,
    runtimeUpdate: forbidden,
    beginSetupOperation: forbidden,
    prepareRuntime: forbidden,
    forgetRuntime: forbidden,
    publishSetupOutcome: forbidden,
    publishProviderDiagnosis: forbidden,
    listHosts: forbidden,
    browse: forbidden,
    validateLaunchAttachments: forbidden,
    callHostTool: forbidden,
    connectedHosts: Effect.die("Unexpected connected hosts"),
  });
  const http = HttpClient.make((request) => {
    state.httpCalls.push(request.url);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({ ...descriptor, environmentId: remote }, { status: state.httpStatus }),
      ),
    );
  });
  const service = yield* HubNodes.make.pipe(
    Effect.provideService(HubNodeRepository.HubNodeRepository, repository),
    Effect.provideService(LinkedHosts.LinkedHosts, linked),
    Effect.provideService(CloudMachineService.CloudMachineService, cloud),
    Effect.provideService(SshRemoteDispatch.SshRemoteDispatch, ssh),
    Effect.provideService(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(hub),
      getDescriptor: Effect.succeed(descriptor),
    }),
    Effect.provideService(HttpClient.HttpClient, http),
  );
  return { service, state, repository, linkSignals, cloudSignals, listeners };
});
const run = <A, E>(
  body: (
    f: Effect.Success<typeof fixture>,
  ) => Effect.Effect<A, E, Scope.Scope | SqlClient.SqlClient>,
) =>
  Effect.scoped(Effect.flatMap(fixture, body)).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
  );

describe("HubNodes", () => {
  it.effect.each(
    (["sql", "linked", "cloud"] as const).flatMap((source) =>
      [false, true].map((failFirst) => ({ source, failFirst })),
    ),
  )(
    "keeps a subscriber alive after $source snapshot failure (first=$failFirst)",
    ({ source, failFirst }) =>
      run(({ service, state }) =>
        Effect.gen(function* () {
          const initial = yield* Deferred.make<void>();
          const failed = yield* Deferred.make<void>();
          state.onSnapshotFailure = Deferred.succeed(failed, undefined).pipe(Effect.asVoid);
          if (failFirst) state.snapshotFailure = source;
          const observing = yield* service.changes.pipe(
            Stream.tap(() => Deferred.succeed(initial, undefined)),
            Stream.take(failFirst ? 1 : 2),
            Stream.runCollect,
            Effect.forkScoped,
          );
          if (!failFirst) {
            yield* Deferred.await(initial);
            state.snapshotFailure = source;
            yield* service.dismissNotice("desktop-import-locked");
          }
          yield* Deferred.await(failed);
          yield* TestClock.adjust(0);
          expect(observing.pollUnsafe()).toBeUndefined();
          state.snapshotFailure = null;
          state.links = [link];
          yield* service.dismissNotice("desktop-import-locked");
          const observed = yield* Fiber.join(observing);
          expect(observed.map((snapshot) => snapshot.nodes.length)).toEqual(
            failFirst ? [1] : [0, 1],
          );
        }),
      ),
  );
  it.effect("coalesces a burst while a subscriber is blocked and delivers the latest state", () =>
    run(({ service, state }) =>
      Effect.gen(function* () {
        const initial = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const observed: string[][] = [];
        const observing = yield* service.changes.pipe(
          Stream.runForEach((snapshot) =>
            Effect.gen(function* () {
              observed.push(snapshot.nodes.map((node) => node.label));
              if (observed.length === 1) {
                yield* Deferred.succeed(initial, undefined);
                yield* Deferred.await(release);
              }
            }),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(initial);
        const reads = state.snapshotReads;
        for (let index = 0; index < 20; index++) {
          state.links = [{ ...link, label: `Box ${index}` }];
          yield* service.dismissNotice("desktop-import-locked");
        }
        yield* Deferred.succeed(release, undefined);
        yield* TestClock.adjust(0);
        expect(state.snapshotReads - reads).toBeLessThanOrEqual(2);
        expect(observed).toEqual([[], ["Box 19"]]);
        yield* Fiber.interrupt(observing);
      }),
    ),
  );
  it.effect("refuses a linked self replacement before changing the catalog or route state", () =>
    run(({ service, state, repository }) =>
      Effect.gen(function* () {
        state.links = [link];
        yield* service.check({});
        const previous = yield* repository.listRouteState;
        state.linkedIdentity = hub;
        expect(
          yield* service
            .add(
              {
                kind: "linked",
                name: link.name,
                url: link.baseUrl,
                code: "code",
                access: "full-access",
              },
              options,
            )
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "refused" });
        expect(state.links).toEqual([link]);
        expect(yield* repository.listRouteState).toEqual(previous);
      }),
    ),
  );
  it.effect(
    "deletes forgotten cloud route state and does not recreate it on repeated invalidation",
    () =>
      run(({ service, state, repository, listeners }) =>
        Effect.gen(function* () {
          const alias = machine().alias;
          state.machines = [machine("running")];
          yield* service.check({});
          expect(yield* repository.listRouteState).toHaveLength(1);
          const initial = yield* Deferred.make<void>();
          const observing = yield* service.changes.pipe(
            Stream.tap(() => Deferred.succeed(initial, undefined)),
            Stream.take(2),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* Deferred.await(initial);
          state.machines = [];
          yield* listeners[0]!(alias, "lifecycle");
          expect((yield* Fiber.join(observing))[1]!.nodes).toEqual([]);
          expect(yield* repository.listRouteState).toEqual([]);
          yield* listeners[0]!(alias, "lifecycle");
          expect(yield* repository.listRouteState).toEqual([]);
        }),
      ),
  );
  it.effect(
    "does not let a check that outlives a forgotten cloud machine write its state back",
    () =>
      run(({ service, state, repository, listeners }) =>
        Effect.gen(function* () {
          const alias = machine().alias;
          state.machines = [machine("running")];
          const identifying = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          state.identifyEffect = Deferred.succeed(identifying, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(remote),
          );
          const checking = yield* service.check({}).pipe(Effect.forkScoped);
          yield* Deferred.await(identifying);
          state.machines = [];
          yield* listeners[0]!(alias, "lifecycle");
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(checking);
          expect(yield* repository.listRouteState).toEqual([]);
        }),
      ),
  );
  it.effect("does not report a cloud machine stopped during a check as online", () =>
    run(({ service, state, repository, listeners }) =>
      Effect.gen(function* () {
        const alias = machine().alias;
        state.machines = [machine("running")];
        const identifying = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        state.identifyEffect = Deferred.succeed(identifying, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(remote),
        );
        const checking = yield* service.check({}).pipe(Effect.forkScoped);
        yield* Deferred.await(identifying);
        state.machines = [machine("archived")];
        yield* listeners[0]!(alias, "lifecycle");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(checking);
        expect((yield* repository.listRouteState).map((row) => row.status)).toEqual(["unknown"]);
      }),
    ),
  );
  it.effect("keeps a cloud route's check result when only its SSH endpoint was refreshed", () =>
    run(({ service, state, repository, listeners }) =>
      Effect.gen(function* () {
        const alias = machine().alias;
        state.machines = [machine("running")];
        state.identifyEffect = listeners[0]!(alias, "endpoint").pipe(Effect.as(remote));
        const checked = yield* service.check({});
        expect(checked.nodes[0]).toMatchObject({ environmentId: remote, status: "online" });
        yield* listeners[0]!(alias, "endpoint");
        expect((yield* repository.listRouteState).map((row) => row.status)).toEqual(["online"]);
      }),
    ),
  );
  it.effect("reads a headless local snapshot without desktop broker, HTTP, SSH, or Boat", () =>
    run(({ service, state }) =>
      Effect.gen(function* () {
        state.links = [link];
        state.machines = [machine()];
        const snapshot = yield* service.snapshot;
        expect(snapshot.nodes).toHaveLength(2);
        expect(snapshot.nodes.every((node) => node.status === "unknown")).toBe(true);
        expect(state.cloudLists).toBe(0);
        expect(state.identify).toEqual([]);
        expect(state.httpCalls).toEqual([]);
      }),
    ),
  );
  it.effect("delivers another caller's add and drops consecutive identical snapshots", () =>
    run(({ service }) =>
      Effect.gen(function* () {
        const initial = yield* Deferred.make<void>();
        const snapshots = yield* service.changes.pipe(
          Stream.tap(() => Deferred.succeed(initial, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(initial);
        yield* service.dismissNotice("desktop-import-locked");
        const result = yield* service.add(sshInput(), options);
        const observed = yield* Fiber.join(snapshots);
        expect(observed.map((snapshot) => snapshot.nodes.length)).toEqual([0, 1]);
        expect(observed[1]!.nodes[0]).toEqual(result.node);
      }),
    ),
  );
  it.effect("does not lose an add racing the initial snapshot read", () =>
    run(({ service, state }) =>
      Effect.gen(function* () {
        const reading = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        state.afterRead = Deferred.succeed(reading, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        const snapshots = yield* service.changes.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(reading);
        yield* service.add(sshInput(), options);
        yield* Deferred.succeed(release, undefined);
        const observed = yield* Fiber.join(snapshots);
        expect(observed.map((snapshot) => snapshot.nodes.length)).toEqual([0, 1]);
      }),
    ),
  );
  it.effect(
    "merges registered SSH and linked identity, resolves old route ids, and updates labels",
    () =>
      run(({ service, state }) =>
        Effect.gen(function* () {
          state.links = [link];
          const first = yield* service.add({ ...sshInput(), label: "SSH box" }, options);
          expect(first.created).toBe(false);
          expect(first.node.routes).toHaveLength(2);
          expect(yield* service.get("route:ssh:box")).toEqual(Option.some(first.node));
          const second = yield* service.add({ ...sshInput(), label: "Renamed" }, options);
          expect(second.created).toBe(false);
          expect(second.node.label).toBe("Renamed");
        }),
      ),
  );
  it.effect("checks stopped cloud offline without SSH; running cloud learns its identity", () =>
    run(({ service, state }) =>
      Effect.gen(function* () {
        state.machines = [machine()];
        expect((yield* service.check({})).nodes[0]!.status).toBe("offline");
        expect(state.identify).toEqual([]);
        expect(state.cloudLists).toBe(1);
        state.machines = [machine("running")];
        const checked = yield* service.check({});
        expect(checked.nodes[0]).toMatchObject({ environmentId: remote, status: "online" });
        expect(state.identify).toEqual([state.machines[0]!.alias]);
        expect(state.cloudLists).toBe(2);
      }),
    ),
  );
  it.effect("gates absent cloud machines even when their reported state looks ready", () =>
    run(({ service, state }) =>
      Effect.gen(function* () {
        state.machines = [{ ...machine("running"), presence: "unknown" }];
        expect((yield* service.check({})).nodes[0]!.status).toBe("offline");
        expect(state.identify).toEqual([]);
      }),
    ),
  );
  it.effect("checks linked descriptor without a token and merges the learned identity", () =>
    run(({ service, state }) =>
      Effect.gen(function* () {
        state.links = [link];
        yield* service.add(sshInput(), options);
        expect(
          (yield* service.check({})).nodes[0]!.routes.every((route) => route.status === "online"),
        ).toBe(true);
        expect(state.httpCalls).toEqual(["https://box.example/.well-known/goat/environment"]);
      }),
    ),
  );
  it.effect("times out a hanging route after 15 seconds and persists safe offline state", () =>
    run(({ service, state, repository }) =>
      Effect.gen(function* () {
        yield* service.add(sshInput(), options);
        const checking = yield* Deferred.make<void>();
        state.identifyEffect = Deferred.succeed(checking, undefined).pipe(
          Effect.andThen(Effect.never),
        );
        const check = yield* service.check({}).pipe(Effect.forkScoped);
        yield* Deferred.await(checking);
        yield* TestClock.adjust("15 seconds");
        expect((yield* Fiber.join(check)).nodes[0]!.status).toBe("offline");
        const route = (yield* repository.listRouteState)[0]!;
        expect(route.lastSeenAt).not.toBeNull();
        expect(route.lastError!.length).toBeLessThanOrEqual(500);
      }),
    ),
  );
  it.effect(
    "imports once, skips cloud aliases and duplicates, and keeps existing registrations",
    () =>
      run(({ service, repository }) =>
        Effect.gen(function* () {
          yield* service.add({ ...sshInput("existing"), label: "Original" }, options);
          const profiles = [
            profile,
            profile,
            { ...profile, ssh: { ...profile.ssh, alias: "existing" } },
            { ...profile, ssh: { ...profile.ssh, alias: "boat-owned" } },
          ];
          expect(
            yield* service.importProfiles({
              source: "desktop-catalog",
              catalog: { state: "readable", profiles },
            }),
          ).toEqual({ outcome: "imported", imported: 1 });
          expect(
            (yield* repository.listRegistrations).find((row) => row.routeId === "ssh:existing")!
              .label,
          ).toBe("Original");
          expect(
            (yield* repository.listRouteState).find((row) => row.routeId === "ssh:box")!.status,
          ).toBe("unknown");
          expect(
            yield* service.importProfiles({
              source: "desktop-catalog",
              catalog: { state: "readable", profiles },
            }),
          ).toEqual({ outcome: "already_imported", imported: 0 });
          expect(
            yield* service.importProfiles({
              source: "desktop-catalog",
              catalog: { state: "locked" },
            }),
          ).toEqual({ outcome: "already_imported", imported: 0 });
        }),
      ),
  );
  it.effect("keeps a locked notice dismissal on repeat and clears it after readable import", () =>
    run(({ service, repository }) =>
      Effect.gen(function* () {
        const locked = {
          source: "desktop-catalog" as const,
          catalog: { state: "locked" as const },
        };
        expect(yield* service.importProfiles(locked)).toEqual({
          outcome: "skipped_locked",
          imported: 0,
        });
        expect((yield* service.snapshot).notices).toHaveLength(1);
        expect(yield* service.dismissNotice("desktop-import-locked")).toEqual({ dismissed: true });
        expect(yield* service.dismissNotice("desktop-import-locked")).toEqual({ dismissed: false });
        yield* service.importProfiles(locked);
        expect((yield* service.snapshot).notices).toEqual([]);
        yield* service.importProfiles({
          source: "desktop-catalog",
          catalog: { state: "readable", profiles: [profile] },
        });
        expect((yield* service.snapshot).notices).toEqual([]);
        expect((yield* repository.getImport)!.outcome).toBe("imported");
      }),
    ),
  );
  it.effect(
    "refuses whole-node cloud removal before touching other routes; linked removal unlinks",
    () =>
      run(({ service, state, repository }) =>
        Effect.gen(function* () {
          state.machines = [machine("running")];
          state.links = [link];
          yield* service.add(sshInput(), options);
          yield* service.check({});
          expect(yield* service.remove({ nodeId: remote }).pipe(Effect.flip)).toMatchObject({
            reason: "refused",
          });
          expect(state.unlinked).toEqual([]);
          expect(yield* repository.listRegistrations).toHaveLength(1);
          const before = (yield* service.snapshot).nodes[0]!;
          expect(yield* service.remove({ nodeId: remote, routeId: "linked:linked" })).toEqual({
            removed: before,
          });
          expect(state.unlinked).toEqual(["linked"]);
          expect((yield* service.snapshot).nodes[0]!.routes).toHaveLength(2);
          yield* service.remove({ nodeId: remote, routeId: "ssh:box" });
          expect(yield* repository.listRegistrations).toEqual([]);
        }),
      ),
  );
  it.effect(
    "refuses required unknown identity, hub self, cloud aliases, and invalid aliases without saving",
    () =>
      run(({ service, state, repository }) =>
        Effect.gen(function* () {
          state.identity = null;
          expect(
            yield* service.add(sshInput(), { ...options, requireIdentity: true }).pipe(Effect.flip),
          ).toMatchObject({
            reason: "invalid_request",
            detail: "GOAT has not run on box yet; run goat_ssh_host_prepare first",
          });
          state.identity = hub;
          expect(yield* service.add(sshInput(), options).pipe(Effect.flip)).toMatchObject({
            reason: "refused",
          });
          expect(
            yield* service.add(sshInput("boat-owned"), options).pipe(Effect.flip),
          ).toMatchObject({ reason: "refused" });
          expect(yield* service.add(sshInput("-bad"), options).pipe(Effect.flip)).toMatchObject({
            reason: "invalid_request",
          });
          expect(yield* repository.listRegistrations).toEqual([]);
          expect(yield* repository.listRouteState).toEqual([]);
        }),
      ),
  );
  it.effect("rechecks authority immediately before saving and preserves the caller error", () =>
    run(({ service, repository }) =>
      Effect.gen(function* () {
        expect(
          yield* service
            .add(sshInput(), { ...options, beforeSave: Effect.fail("caller changed") })
            .pipe(Effect.flip),
        ).toBe("caller changed");
        expect(yield* repository.listRegistrations).toEqual([]);
      }),
    ),
  );
  it.effect("keeps unknown route ids until a later check learns identity", () =>
    run(({ service, state }) =>
      Effect.gen(function* () {
        state.identity = null;
        expect((yield* service.add(sshInput(), options)).node.nodeId).toBe("route:ssh:box");
        state.identity = remote;
        yield* service.check({});
        expect(Option.getOrThrow(yield* service.get("route:ssh:box")).nodeId).toBe(remote);
      }),
    ),
  );
  it.effect("publishes independent source changes and resets invalidated cloud status", () =>
    run(({ service, state, linkSignals, listeners }) =>
      Effect.gen(function* () {
        state.machines = [machine("running")];
        yield* service.check({});
        const initial = yield* Deferred.make<void>();
        const changed = yield* service.changes.pipe(
          Stream.tap(() => Deferred.succeed(initial, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(initial);
        yield* listeners[0]!(state.machines[0]!.alias, "lifecycle");
        const observed = yield* Fiber.join(changed);
        expect(observed[1]!.nodes[0]!.status).toBe("unknown");
        const read = yield* Deferred.make<void>();
        const linkedChange = yield* service.changes.pipe(
          Stream.tap(() => Deferred.succeed(read, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(read);
        state.links = [{ ...link, environmentId: "env-another" }];
        yield* PubSub.publish(linkSignals, undefined);
        expect((yield* Fiber.join(linkedChange))[1]!.nodes).toHaveLength(2);
      }),
    ),
  );
});

it.effect("rolls back all import rows and the import marker when a later write fails", () =>
  run(({ service, repository }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TRIGGER reject_import BEFORE INSERT ON hub_node_registrations
    WHEN NEW.route_id = 'ssh:bad' BEGIN SELECT RAISE(ABORT, 'test storage failure'); END`;
      expect(
        yield* service
          .importProfiles({
            source: "desktop-catalog",
            catalog: {
              state: "readable",
              profiles: [profile, { ...profile, ssh: { ...profile.ssh, alias: "bad" } }],
            },
          })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "storage_failed" });
      expect(yield* repository.listRegistrations).toEqual([]);
      expect(yield* repository.listRouteState).toEqual([]);
      expect(yield* repository.getImport).toBeUndefined();
    }),
  ),
);

it.effect("decodes stored JSON through Schema and rejects a corrupt registration", () =>
  run(({ service }) =>
    Effect.gen(function* () {
      yield* service.add(sshInput(), options);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE hub_node_registrations SET target_json = '{"kind":"invalid"}' WHERE route_id = 'ssh:box'`;
      expect(yield* service.snapshot.pipe(Effect.flip)).toMatchObject({ reason: "storage_failed" });
    }),
  ),
);

it.effect("limits route probes to four concurrent calls", () =>
  run(({ service, state }) =>
    Effect.gen(function* () {
      yield* service.importProfiles({
        source: "desktop-catalog",
        catalog: {
          state: "readable",
          profiles: Array.from({ length: 5 }, (_, index) => ({
            ...profile,
            environmentId: EnvironmentId.make(`env-${index}`),
            ssh: { ...profile.ssh, alias: `box-${index}` },
          })),
        },
      });
      const fourStarted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let active = 0;
      let maximum = 0;
      state.identifyEffect = Effect.acquireUseRelease(
        Effect.gen(function* () {
          active++;
          maximum = Math.max(maximum, active);
          if (active === 4) yield* Deferred.succeed(fourStarted, undefined);
        }),
        () => Deferred.await(release).pipe(Effect.as(remote)),
        () =>
          Effect.sync(() => {
            active--;
          }),
      );
      const checking = yield* service.check({}).pipe(Effect.forkScoped);
      yield* Deferred.await(fourStarted);
      expect(state.identify).toHaveLength(4);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(checking);
      expect(state.identify).toHaveLength(5);
      expect(maximum).toBe(4);
    }),
  ),
);

it.effect("signals cloud catalog changes from another caller", () =>
  run(({ service, state, cloudSignals }) =>
    Effect.gen(function* () {
      const initial = yield* Deferred.make<void>();
      const observing = yield* service.changes.pipe(
        Stream.tap(() => Deferred.succeed(initial, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Deferred.await(initial);
      state.machines = [machine()];
      yield* PubSub.publish(cloudSignals, undefined);
      expect((yield* Fiber.join(observing))[1]!.nodes[0]!.kind).toBe("cloud");
    }),
  ),
);

it.effect(
  "marks an initially unavailable linked route offline while retaining its known identity",
  () =>
    run(({ service, state }) =>
      Effect.gen(function* () {
        state.links = [link];
        state.httpStatus = 503;
        expect((yield* service.check({})).nodes[0]).toMatchObject({
          nodeId: remote,
          status: "offline",
        });
      }),
    ),
);
