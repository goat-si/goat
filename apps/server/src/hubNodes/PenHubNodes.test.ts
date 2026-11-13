import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ExecutionEnvironmentDescriptor } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import type { PenMembershipView } from "@goat/ssh/penMembershipWatch";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";

import * as CloudMachineService from "../cloudMachines/CloudMachineService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as LinkedHosts from "../linkedHosts/LinkedHosts.ts";
import migration from "../persistence/Migrations/106_HubNodes.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as HubNodeRepository from "./HubNodeRepository.ts";
import * as HubNodes from "./HubNodes.ts";
import * as PenHubNodes from "./PenHubNodes.ts";
import {
  PenManagedRoutes,
  PenRouteCleanupError,
  type PenManagedRoutesShape,
  type PenRouteBinding,
} from "./PenManagedRoutes.ts";

const hub = EnvironmentId.make("env-hub");
const remote = EnvironmentId.make("env-box");
const descriptor = Schema.decodeSync(ExecutionEnvironmentDescriptor)({
  environmentId: hub,
  label: "Hub",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "test",
  capabilities: { repositoryIdentity: true },
});
const unused = () => Effect.die("not used by Pen reconciliation");
const id = (letter: string) => letter.repeat(26);
const key = (letter: string) => letter.repeat(43);
const alias = (letter: string) => `pen-${id(letter)}`;
const member = (letter: string, noise = letter) => ({
  meshId: id("m"),
  nodeId: id(letter),
  noisePub: key(noise),
  name: `box-${letter}`,
});
const user = { kind: "user", at: "2026-11-13T00:00:00.000Z" } as const;

const fixture = Effect.gen(function* () {
  yield* migration;
  const repository = yield* HubNodeRepository.HubNodeRepository.pipe(
    Effect.provide(HubNodeRepository.layer),
  );
  const state = {
    events: [] as string[],
    held: new Map<string, PenRouteBinding>(),
    releaseFails: false,
    identity: remote as EnvironmentId | null,
    identify: Effect.void as Effect.Effect<void>,
  };
  const routes: PenManagedRoutesShape = {
    isManaged: (name) => state.held.has(name),
    binding: (name) => state.held.get(name),
    admit: unused,
    hold: (name, binding) =>
      Effect.sync(() => {
        state.events.push(`hold ${name}`);
        state.held.set(name, binding);
      }),
    release: (name) =>
      Effect.suspend(() => {
        state.events.push(`release ${name}`);
        if (state.releaseFails) return Effect.fail(new PenRouteCleanupError({ alias: name }));
        state.held.delete(name);
        return Effect.void;
      }),
    registerCleanup: () => Effect.void,
  };
  const ssh = SshRemoteDispatch.SshRemoteDispatch.of({
    identifyTarget: (target: { readonly alias: string }) =>
      Effect.suspend(() => {
        state.events.push(`identify ${target.alias} managed=${state.held.has(target.alias)}`);
        return state.identify.pipe(Effect.as(state.identity));
      }),
  } as unknown as SshRemoteDispatch.SshRemoteDispatch["Service"]);
  const service = yield* HubNodes.make.pipe(
    Effect.provideService(HubNodeRepository.HubNodeRepository, repository),
    Effect.provideService(PenManagedRoutes, routes),
    Effect.provideService(
      LinkedHosts.LinkedHosts,
      LinkedHosts.LinkedHosts.of({
        changes: Stream.never,
        list: Effect.succeed([]),
        names: Effect.succeed([]),
        find: () => Effect.succeedNone,
        refreshLabel: () => Effect.void,
        link: unused,
        unlink: unused,
      }),
    ),
    Effect.provideService(CloudMachineService.CloudMachineService, {
      changes: Stream.never,
      catalog: Effect.succeed([]),
      onAliasInvalidated: () => Effect.void,
    } as unknown as CloudMachineService.CloudMachineService["Service"]),
    Effect.provideService(SshRemoteDispatch.SshRemoteDispatch, ssh),
    Effect.provideService(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(hub),
      getDescriptor: Effect.succeed(descriptor),
    }),
    Effect.provideService(HttpClient.HttpClient, HttpClient.make(unused)),
  );
  const rows = Effect.map(repository.listRegistrations, (all) =>
    all.map((row) => [row.routeId, row.addedBy.kind, row.addedBy.pen?.noisePub ?? null]),
  );
  return { service, state, rows, repository };
});
const run = <A, E>(body: (f: Effect.Success<typeof fixture>) => Effect.Effect<A, E, never>) =>
  Effect.scoped(Effect.flatMap(fixture, body)).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
  );
const current = { isCurrent: () => true };

describe("HubNodes Pen registrations", () => {
  it.effect("a member is guarded before it is listed, and closed before it is forgotten", () =>
    run(({ service, state, rows }) =>
      Effect.gen(function* () {
        const first = yield* service.reconcilePen({ members: [member("a")], ...current });
        expect(first).toEqual({ added: [`ssh:${alias("a")}`], retry: false });
        const node = (yield* service.snapshot).nodes[0];
        expect(node).toMatchObject({ label: "box-a", environmentId: null, status: "unknown" });
        expect(node?.routes[0]?.pen).toEqual({
          meshId: id("m"),
          nodeId: id("a"),
          noisePub: key("a"),
        });
        // The same list again writes nothing.
        expect(yield* service.reconcilePen({ members: [member("a")], ...current })).toEqual({
          added: [],
          retry: false,
        });
        expect(yield* service.reconcilePen({ members: [], ...current })).toEqual({
          added: [],
          retry: false,
        });
        expect(yield* rows).toEqual([]);
        expect(state.events).toEqual([`hold ${alias("a")}`, `release ${alias("a")}`]);
      }),
    ),
  );

  it.effect("a route that cannot be closed yet stays listed and blocked, and is retried", () =>
    run(({ service, state, rows }) =>
      Effect.gen(function* () {
        yield* service.reconcilePen({ members: [member("a")], ...current });
        state.releaseFails = true;
        expect(yield* service.reconcilePen({ members: [], ...current })).toEqual({
          added: [],
          retry: true,
        });
        expect(yield* rows).toEqual([[`ssh:${alias("a")}`, "import", key("a")]]);
        expect(state.held.has(alias("a"))).toBe(true);
        state.releaseFails = false;
        expect((yield* service.reconcilePen({ members: [], ...current })).retry).toBe(false);
        expect(yield* rows).toEqual([]);
      }),
    ),
  );

  it.effect("a member whose key changed is closed and listed again under the new key", () =>
    run(({ service, state, rows }) =>
      Effect.gen(function* () {
        yield* service.reconcilePen({ members: [member("a")], ...current });
        yield* service.reconcilePen({ members: [member("a", "x")], ...current });
        expect(yield* rows).toEqual([[`ssh:${alias("a")}`, "import", key("x")]]);
        expect(state.held.get(alias("a"))?.noisePub).toBe(key("x"));
        expect(state.events).toEqual([
          `hold ${alias("a")}`,
          `release ${alias("a")}`,
          `hold ${alias("a")}`,
        ]);
      }),
    ),
  );

  it.effect("a host a person added under a Pen alias is never taken over or removed", () =>
    run(({ service, state, rows }) =>
      Effect.gen(function* () {
        const input = {
          kind: "ssh" as const,
          alias: alias("a"),
          hostname: null,
          username: null,
          port: null,
        };
        yield* service.add(input, { addedBy: user, beforeSave: Effect.void });
        yield* service.reconcilePen({ members: [member("a")], ...current });
        yield* service.reconcilePen({ members: [], ...current });
        expect(yield* rows).toEqual([[`ssh:${alias("a")}`, "user", null]]);
        expect(state.events.filter((event) => !event.startsWith("identify"))).toEqual([]);
      }),
    ),
  );

  it.effect("a person adding a Pen route by hand owns it once Pen's route is closed", () =>
    run(({ service, state, rows }) =>
      Effect.gen(function* () {
        yield* service.reconcilePen({ members: [member("a")], ...current });
        const input = {
          kind: "ssh" as const,
          alias: alias("a"),
          hostname: null,
          username: null,
          port: null,
        };
        state.releaseFails = true;
        const refused = yield* Effect.flip(
          service.add(input, { addedBy: user, beforeSave: Effect.void }),
        );
        expect(refused.reason).toBe("host_unavailable");
        expect(yield* rows).toEqual([[`ssh:${alias("a")}`, "import", key("a")]]);
        state.releaseFails = false;
        yield* service.add(input, { addedBy: user, beforeSave: Effect.void });
        expect(yield* rows).toEqual([[`ssh:${alias("a")}`, "user", null]]);
        expect(state.held.has(alias("a"))).toBe(false);
        // Still a member afterwards: the person's row stays theirs.
        yield* service.reconcilePen({ members: [member("a")], ...current });
        expect(yield* rows).toEqual([[`ssh:${alias("a")}`, "user", null]]);
      }),
    ),
  );

  it.effect("removing a Pen route by hand closes it first", () =>
    run(({ service, state, rows }) =>
      Effect.gen(function* () {
        yield* service.reconcilePen({ members: [member("a")], ...current });
        yield* service.remove({ nodeId: `route:ssh:${alias("a")}` });
        expect(yield* rows).toEqual([]);
        expect(state.held.size).toBe(0);
      }),
    ),
  );

  it.effect("a pass for an older member list writes nothing", () =>
    run(({ service, state, rows }) =>
      Effect.gen(function* () {
        expect(
          yield* service.reconcilePen({ members: [member("a")], isCurrent: () => false }),
        ).toEqual({ added: [], retry: false });
        expect(yield* rows).toEqual([]);
        expect(state.events).toEqual([]);
      }),
    ),
  );
});

const ready = (...members: Array<readonly [string, string, boolean?]>): PenMembershipView => ({
  kind: "ready",
  selfName: "hub",
  snapshot: {
    gen: 1,
    mesh: id("m"),
    self: id("s"),
    revoked: [],
    members: [["s", "s"] as const, ...members].map(([node, noise, online]) => ({
      nodeId: id(node),
      noisePub: key(noise),
      name: `box-${node}`,
      online: online ?? true,
    })),
  },
});

const reconciler = (enabled = true) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const pinned = new Map<string, string>();
    const inspected: string[] = [];
    const { pass } = yield* PenHubNodes.make({
      inspect: (name) =>
        Effect.sync(() => {
          inspected.push(name);
          const noisePub = pinned.get(name);
          return noisePub === undefined
            ? { refused: "not-in-pen-config" as const }
            : {
                alias: name,
                nodeId: name.slice(4),
                noisePub,
                revision: "pen:test",
                target: { alias: name, hostname: name, username: null, port: null },
              };
        }),
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HubNodes.HubNodes, f.service),
          ServerSettingsService.layerTest({ penHubNodes: enabled }),
        ),
      ),
    );
    const show = (view: PenMembershipView) => pass(view).pipe(Effect.orDie);
    return { ...f, show, pinned, inspected };
  });
const reconcile = <A, E>(
  body: (f: Effect.Success<ReturnType<typeof reconciler>>) => Effect.Effect<A, E, never>,
  enabled = true,
) =>
  Effect.scoped(Effect.flatMap(reconciler(enabled), body)).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
  );

describe("PenHubNodes", () => {
  it.effect("lists only members whose exact alias pins the key Pen names, and never itself", () =>
    reconcile(({ show, pinned, rows, inspected, service }) =>
      Effect.gen(function* () {
        pinned.set(alias("a"), key("a"));
        pinned.set(alias("b"), key("x"));
        yield* show(ready(["a", "a"], ["b", "b"], ["c", "c"]));
        expect(yield* rows).toEqual([[`ssh:${alias("a")}`, "import", key("a")]]);
        expect(inspected).not.toContain(alias("s"));
        // Its identity was read once, through the guard, with nothing prepared.
        const node = (yield* service.snapshot).nodes[0];
        expect(node).toMatchObject({ environmentId: remote, status: "online" });
      }),
    ),
  );

  it.effect("Pen going down keeps the list; a departure or leaving the mesh empties it", () =>
    reconcile(({ show, pinned, rows }) =>
      Effect.gen(function* () {
        pinned.set(alias("a"), key("a"));
        pinned.set(alias("b"), key("b"));
        yield* show(ready(["a", "a"], ["b", "b"]));
        expect((yield* rows).length).toBe(2);
        yield* show({ kind: "unavailable", reason: "daemon-down" });
        expect((yield* rows).length).toBe(2);
        yield* show(ready(["a", "a"]));
        expect(yield* rows).toEqual([[`ssh:${alias("a")}`, "import", key("a")]]);
        yield* show({ kind: "not-member" });
        expect(yield* rows).toEqual([]);
      }),
    ),
  );

  it.effect("with the setting off nothing is listed", () =>
    reconcile(
      ({ show, pinned, rows, inspected }) =>
        Effect.gen(function* () {
          pinned.set(alias("a"), key("a"));
          yield* show(ready(["a", "a"]));
          expect(yield* rows).toEqual([]);
          expect(inspected).toEqual([]);
        }),
      false,
    ),
  );

  it.effect("an offline member is listed without being dialled", () =>
    reconcile(({ show, pinned, state, service }) =>
      Effect.gen(function* () {
        pinned.set(alias("a"), key("a"));
        yield* show(ready(["a", "a", false]));
        expect((yield* service.snapshot).nodes[0]).toMatchObject({ status: "unknown" });
        expect(state.events.some((event) => event.startsWith("identify"))).toBe(false);
      }),
    ),
  );

  it.effect("a member that leaves while its identity is being read is removed afterwards", () =>
    reconcile(({ show, pinned, rows, state }) =>
      Effect.gen(function* () {
        const reading = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        state.identify = Deferred.succeed(reading, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        pinned.set(alias("a"), key("a"));
        const shown = yield* show(ready(["a", "a"])).pipe(Effect.forkChild);
        yield* Deferred.await(reading);
        const left = yield* show(ready()).pipe(Effect.forkChild);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(shown);
        yield* Fiber.join(left);
        expect(yield* rows).toEqual([]);
        expect(state.held.size).toBe(0);
      }),
    ),
  );
});
