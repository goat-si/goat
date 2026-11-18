import { describe, expect, it } from "@effect/vitest";
import { nativePenCandidates } from "./penNativeDiscovery.ts";

describe("Pen native discovery", () => {
  it("includes members whose SSH route is refused and excludes self", () => {
    const state = {
      kind: "ready" as const,
      seq: 1,
      meshId: "mmmmmmmmmmmmmmmmmmmmmmmmmm",
      selfNodeId: "self",
      members: [
        {
          nodeId: "nnnnnnnnnnnnnnnnnnnnnnnnnn",
          name: "Node",
          online: true,
          noisePub: "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
          route: { kind: "refused" as const, reason: "not-pen-route" as const },
        },
        {
          nodeId: "self",
          name: "Self",
          online: true,
          noisePub: "self-key",
          route: { kind: "refused" as const, reason: "not-pen-route" as const },
        },
      ],
    };
    expect(nativePenCandidates(state).map((member) => member.nodeId)).toEqual([
      "nnnnnnnnnnnnnnnnnnnnnnnnnn",
    ]);
  });
});

import { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import {
  PenRouteGateway,
  PenViewerPolicy,
  type PenMembersInput,
} from "../platform/capabilities.ts";
import {
  PenConnectionProfile,
  SshConnectionProfile,
  type ConnectionCatalogEntry,
} from "./catalog.ts";
import { PenConnectionTarget, SshConnectionTarget, penConnectionId } from "./model.ts";
import { PenMembership } from "./penMembership.ts";
import { EnvironmentRegistry } from "./registry.ts";
import { makePenNativeDiscovery } from "./penNativeDiscovery.ts";

it.effect("keeps routes during unavailable membership and closes only native routes on leave", () =>
  Effect.gen(function* () {
    const env = EnvironmentId.make("env");
    const id = penConnectionId("mmmmmmmmmmmmmmmmmmmmmmmmmm", "nnnnnnnnnnnnnnnnnnnnnnnnnn");
    const pin = {
      meshId: "mmmmmmmmmmmmmmmmmmmmmmmmmm",
      nodeId: "nnnnnnnnnnnnnnnnnnnnnnnnnn",
      noisePub: "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    };
    const target = new PenConnectionTarget({ environmentId: env, label: "Node", connectionId: id });
    const ssh = new SshConnectionTarget({
      environmentId: env,
      label: "Node",
      connectionId: "ssh:pen:mmmmmmmmmmmmmmmmmmmmmmmmmm:nnnnnnnnnnnnnnnnnnnnnnnnnn",
    });
    const entry: ConnectionCatalogEntry = {
      enabled: true,
      target,
      profile: Option.some(
        new PenConnectionProfile({ ...pin, environmentId: env, label: "Node", connectionId: id }),
      ),
      alternateRoutes: [
        {
          target: ssh,
          profile: Option.some(
            new SshConnectionProfile({
              environmentId: env,
              label: "Node",
              connectionId: ssh.connectionId,
              target: {
                alias: "nnnnnnnnnnnnnnnnnnnnnnnnnn",
                hostname: "nnnnnnnnnnnnnnnnnnnnnnnnnn",
                username: null,
                port: null,
              },
            }),
          ),
        },
      ],
    };
    const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map([[env, entry]]),
    );
    const latest = yield* SubscriptionRef.make<Option.Option<PenMembersInput>>(Option.none());
    const removed: string[] = [];
    const closed: unknown[] = [];
    const unused = () => Effect.die("unexpected registry call");
    const unusedStream = () => Stream.die("unexpected registry stream");
    const registry = EnvironmentRegistry.of({
      entries,
      networkStatus: yield* SubscriptionRef.make<"unknown" | "online" | "offline">("online"),
      start: Effect.void,
      register: unused,
      registerPlatform: unused,
      assertKnownAddress: unused,
      reconcilePlatform: unused,
      remove: unused,
      removeRoute: (_env, route) =>
        Effect.sync(() => {
          removed.push(route);
        }),
      reorderRoutes: unused,
      removeRelayEnvironments: unused,
      retryNow: unused,
      reconnect: unused,
      setEnabled: unused,
      setCompatibility: unused,
      state: unused,
      stateChanges: unusedStream,
      run: unused,
      runStream: unusedStream,
      followStream: unusedStream,
    });
    yield* Effect.gen(function* () {
      const discovery = yield* makePenNativeDiscovery();
      yield* discovery.pass({ kind: "unavailable", seq: 1, reason: "stale" });
      expect(removed).toEqual([]);
      yield* discovery.pass({ kind: "not-member", seq: 2 });
      expect(removed).toEqual([id]);
      expect(closed).toEqual([pin]);
    }).pipe(
      Effect.provideService(EnvironmentRegistry, registry),
      Effect.provideService(PenMembership, { latest, admit: () => Effect.void }),
      Effect.provideService(PenViewerPolicy, { enabled: true }),
      Effect.provideService(
        PenRouteGateway,
        Option.some({
          open: () => Effect.die("unexpected open"),
          close: (value) =>
            Effect.sync(() => {
              closed.push(value);
            }),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unexpected HTTP")),
      ),
    );
  }),
);

import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

it.effect("drops a descriptor arriving after leave or key rotation", () =>
  Effect.gen(function* () {
    const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map(),
    );
    const latest = yield* SubscriptionRef.make<Option.Option<PenMembersInput>>(Option.none());
    const registered: string[] = [];
    const unused = () => Effect.die("unexpected registry call");
    const unusedStream = () => Stream.die("unexpected registry stream");
    const registry = EnvironmentRegistry.of({
      entries,
      networkStatus: yield* SubscriptionRef.make<"unknown" | "online" | "offline">("online"),
      start: Effect.void,
      register: (value) =>
        Effect.sync(() => {
          registered.push(value.target.label);
          return true;
        }),
      registerPlatform: unused,
      assertKnownAddress: unused,
      reconcilePlatform: unused,
      remove: unused,
      removeRoute: unused,
      reorderRoutes: unused,
      removeRelayEnvironments: unused,
      retryNow: unused,
      reconnect: unused,
      setEnabled: unused,
      setCompatibility: unused,
      state: unused,
      stateChanges: unusedStream,
      run: unused,
      runStream: unusedStream,
      followStream: unusedStream,
    });
    const member = {
      nodeId: "nnnnnnnnnnnnnnnnnnnnnnnnnn",
      name: "Node",
      online: true,
      noisePub: "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
      route: { kind: "refused" as const, reason: "not-pen-route" as const },
    };
    const ready = {
      kind: "ready" as const,
      seq: 1,
      meshId: "mmmmmmmmmmmmmmmmmmmmmmmmmm",
      selfNodeId: "self",
      members: [member],
    };
    for (const next of [
      { ...ready, seq: 2, members: [] },
      { ...ready, seq: 2, members: [{ ...member, noisePub: "rotated" }] },
      ready,
    ]) {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* SubscriptionRef.set(latest, Option.some(ready));
      const client = HttpClient.make((request) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                environmentId: "env",
                label: "Node",
                platform: { os: "darwin", arch: "arm64" },
                serverVersion: "1.0.0",
                capabilities: { repositoryIdentity: true },
              }),
            ),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const discovery = yield* makePenNativeDiscovery();
        const fiber = yield* discovery.pass(ready).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* SubscriptionRef.set(latest, Option.some(next));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(fiber);
      }).pipe(
        Effect.provideService(EnvironmentRegistry, registry),
        Effect.provideService(PenMembership, { latest, admit: () => Effect.void }),
        Effect.provideService(PenViewerPolicy, { enabled: true }),
        Effect.provideService(
          PenRouteGateway,
          Option.some({
            open: () =>
              Effect.succeed({
                kind: "open",
                httpBaseUrl: `http://127.0.0.1/pen-route/${"a".repeat(43)}`,
                socketUrl: "ws://127.0.0.1/ws",
              }),
            close: () => Effect.void,
          }),
        ),
        Effect.provideService(HttpClient.HttpClient, client),
      );
    }
    expect(registered).toEqual(["Node"]);
  }),
);

it.effect(
  "a stored route is read once per run, and replaced when the member's GOAT answers as another environment",
  () =>
    Effect.gen(function* () {
      const stored = EnvironmentId.make("old");
      const id = penConnectionId("mmmmmmmmmmmmmmmmmmmmmmmmmm", "nnnnnnnnnnnnnnnnnnnnnnnnnn");
      const pin = {
        meshId: "mmmmmmmmmmmmmmmmmmmmmmmmmm",
        nodeId: "nnnnnnnnnnnnnnnnnnnnnnnnnn",
        noisePub: "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
      };
      const entries = yield* SubscriptionRef.make<
        ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
      >(
        new Map([
          [
            stored,
            {
              enabled: true,
              target: new PenConnectionTarget({
                environmentId: stored,
                label: "Node",
                connectionId: id,
              }),
              profile: Option.some(
                new PenConnectionProfile({
                  ...pin,
                  environmentId: stored,
                  label: "Node",
                  connectionId: id,
                }),
              ),
            },
          ],
        ]),
      );
      const ready = {
        kind: "ready" as const,
        seq: 1,
        meshId: "mmmmmmmmmmmmmmmmmmmmmmmmmm",
        selfNodeId: "self",
        members: [
          {
            nodeId: "nnnnnnnnnnnnnnnnnnnnnnnnnn",
            name: "Node",
            online: true,
            noisePub: "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
            route: { kind: "refused" as const, reason: "not-pen-route" as const },
          },
        ],
      };
      const latest = yield* SubscriptionRef.make<Option.Option<PenMembersInput>>(
        Option.some(ready),
      );
      const removed: string[] = [];
      const registered: string[] = [];
      let opens = 0;
      const unused = () => Effect.die("unexpected registry call");
      const unusedStream = () => Stream.die("unexpected registry stream");
      const registry = EnvironmentRegistry.of({
        entries,
        networkStatus: yield* SubscriptionRef.make<"unknown" | "online" | "offline">("online"),
        start: Effect.void,
        register: (value) =>
          Effect.sync(() => {
            registered.push(value.target.environmentId);
            return true;
          }),
        registerPlatform: unused,
        assertKnownAddress: unused,
        reconcilePlatform: unused,
        remove: unused,
        removeRoute: (environmentId, route) =>
          Effect.sync(() => {
            removed.push(`${environmentId} ${route}`);
          }),
        reorderRoutes: unused,
        removeRelayEnvironments: unused,
        retryNow: unused,
        reconnect: unused,
        setEnabled: unused,
        setCompatibility: unused,
        state: unused,
        stateChanges: unusedStream,
        run: unused,
        runStream: unusedStream,
        followStream: unusedStream,
      });
      yield* Effect.gen(function* () {
        const discovery = yield* makePenNativeDiscovery();
        yield* discovery.pass(ready);
        yield* discovery.pass({ ...ready, seq: 2 });
      }).pipe(
        Effect.provideService(EnvironmentRegistry, registry),
        Effect.provideService(PenMembership, { latest, admit: () => Effect.void }),
        Effect.provideService(PenViewerPolicy, { enabled: true }),
        Effect.provideService(
          PenRouteGateway,
          Option.some({
            open: () =>
              Effect.sync(() => {
                opens++;
                return {
                  kind: "open" as const,
                  httpBaseUrl: `http://127.0.0.1/pen-route/${"a".repeat(43)}`,
                  socketUrl: "ws://127.0.0.1/ws",
                };
              }),
            close: () => Effect.void,
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  environmentId: "new",
                  label: "Node",
                  platform: { os: "darwin", arch: "arm64" },
                  serverVersion: "1.0.0",
                  capabilities: { repositoryIdentity: true },
                }),
              ),
            ),
          ),
        ),
      );
      expect(removed).toEqual([`old ${id}`]);
      expect(registered).toEqual(["new"]);
      expect(opens).toBe(1);
    }),
);

it.effect("a closed viewer gate keeps a member's stored route and the environment it holds", () =>
  Effect.gen(function* () {
    const env = EnvironmentId.make("env");
    const id = penConnectionId("mmmmmmmmmmmmmmmmmmmmmmmmmm", "nnnnnnnnnnnnnnnnnnnnnnnnnn");
    const pin = {
      meshId: "mmmmmmmmmmmmmmmmmmmmmmmmmm",
      nodeId: "nnnnnnnnnnnnnnnnnnnnnnnnnn",
      noisePub: "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    };
    const target = new PenConnectionTarget({ environmentId: env, label: "Node", connectionId: id });
    // The Pen route is this environment's only one: removing it would delete the environment.
    const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map([
        [
          env,
          {
            enabled: true,
            target,
            profile: Option.some(
              new PenConnectionProfile({
                ...pin,
                environmentId: env,
                label: "Node",
                connectionId: id,
              }),
            ),
            alternateRoutes: [],
          },
        ],
      ]),
    );
    const removed: string[] = [];
    const unused = () => Effect.die("unexpected registry call");
    const unusedStream = () => Stream.die("unexpected registry stream");
    const registry = EnvironmentRegistry.of({
      entries,
      networkStatus: yield* SubscriptionRef.make<"unknown" | "online" | "offline">("online"),
      start: Effect.void,
      register: unused,
      registerPlatform: unused,
      assertKnownAddress: unused,
      reconcilePlatform: unused,
      remove: unused,
      removeRoute: (_env, route) => Effect.sync(() => void removed.push(route)),
      reorderRoutes: unused,
      removeRelayEnvironments: unused,
      retryNow: unused,
      reconnect: unused,
      setEnabled: unused,
      setCompatibility: unused,
      state: unused,
      stateChanges: unusedStream,
      run: unused,
      runStream: unusedStream,
      followStream: unusedStream,
    });
    const member = {
      nodeId: "nnnnnnnnnnnnnnnnnnnnnnnnnn",
      name: "Node",
      online: true,
      noisePub: "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
      route: { kind: "refused" as const, reason: "not-pen-route" as const },
    };
    const ready = {
      kind: "ready" as const,
      seq: 1,
      meshId: "mmmmmmmmmmmmmmmmmmmmmmmmmm",
      selfNodeId: "self",
      members: [member],
    };
    const latest = yield* SubscriptionRef.make<Option.Option<PenMembersInput>>(Option.some(ready));
    // Pen machines turned off, or a client without Pen membership, says nothing about who left.
    // A closed gate keeps the route even when Pen says the member or this machine left.
    const states: ReadonlyArray<PenMembersInput> = [
      ready,
      { kind: "disabled" },
      { ...ready, seq: 2, members: [] },
      { kind: "not-member", seq: 3 },
    ];
    for (const gateway of [Option.none(), Option.some({ open: unused, close: () => Effect.void })])
      yield* Effect.gen(function* () {
        const discovery = yield* makePenNativeDiscovery();
        for (const state of states) yield* discovery.pass(state);
        expect(removed).toEqual([]);
      }).pipe(
        Effect.provideService(EnvironmentRegistry, registry),
        Effect.provideService(PenMembership, { latest, admit: () => Effect.void }),
        Effect.provideService(PenViewerPolicy, { enabled: false }),
        Effect.provideService(PenRouteGateway, gateway),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unexpected HTTP")),
        ),
      );
  }),
);
it.effect("an open gate leaves a stored route whose profile names no Pen member", () =>
  Effect.gen(function* () {
    const env = EnvironmentId.make("env");
    const id = penConnectionId("mmmmmmmmmmmmmmmmmmmmmmmmmm", "nnnnnnnnnnnnnnnnnnnnnnnnnn");
    const target = new PenConnectionTarget({ environmentId: env, label: "Node", connectionId: id });
    // A damaged profile: no Noise key. Read as a pin it would look like a member that rotated away.
    const profile = new PenConnectionProfile({
      meshId: "mmmmmmmmmmmmmmmmmmmmmmmmmm",
      nodeId: "nnnnnnnnnnnnnnnnnnnnnnnnnn",
      noisePub: "",
      environmentId: env,
      label: "Node",
      connectionId: id,
    });
    const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map([
        [env, { enabled: true, target, profile: Option.some(profile), alternateRoutes: [] }],
      ]),
    );
    const removed: string[] = [];
    const unused = () => Effect.die("unexpected registry call");
    const unusedStream = () => Stream.die("unexpected registry stream");
    const registry = EnvironmentRegistry.of({
      entries,
      networkStatus: yield* SubscriptionRef.make<"unknown" | "online" | "offline">("online"),
      start: Effect.void,
      register: unused,
      registerPlatform: unused,
      assertKnownAddress: unused,
      reconcilePlatform: unused,
      remove: unused,
      removeRoute: (_env, route) => Effect.sync(() => void removed.push(route)),
      reorderRoutes: unused,
      removeRelayEnvironments: unused,
      retryNow: unused,
      reconnect: unused,
      setEnabled: unused,
      setCompatibility: unused,
      state: unused,
      stateChanges: unusedStream,
      run: unused,
      runStream: unusedStream,
      followStream: unusedStream,
    });
    const ready = {
      kind: "ready" as const,
      seq: 1,
      meshId: "mmmmmmmmmmmmmmmmmmmmmmmmmm",
      selfNodeId: "self",
      members: [
        {
          nodeId: "nnnnnnnnnnnnnnnnnnnnnnnnnn",
          name: "Node",
          online: false,
          noisePub: "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
          route: { kind: "refused" as const, reason: "not-pen-route" as const },
        },
      ],
    };
    const latest = yield* SubscriptionRef.make<Option.Option<PenMembersInput>>(Option.some(ready));
    yield* Effect.gen(function* () {
      const discovery = yield* makePenNativeDiscovery();
      yield* discovery.pass(ready);
      expect(removed).toEqual([]);
    }).pipe(
      Effect.provideService(EnvironmentRegistry, registry),
      Effect.provideService(PenMembership, { latest, admit: () => Effect.void }),
      Effect.provideService(PenViewerPolicy, { enabled: true }),
      Effect.provideService(
        PenRouteGateway,
        Option.some({ open: unused, close: () => Effect.void }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unexpected HTTP")),
      ),
    );
  }),
);
it.effect("a member's new Noise key keeps its stored route and updates the pin in place", () =>
  Effect.gen(function* () {
    const env = EnvironmentId.make("env");
    const id = penConnectionId("mmmmmmmmmmmmmmmmmmmmmmmmmm", "nnnnnnnnnnnnnnnnnnnnnnnnnn");
    const target = new PenConnectionTarget({ environmentId: env, label: "Node", connectionId: id });
    const profile = new PenConnectionProfile({
      meshId: "mmmmmmmmmmmmmmmmmmmmmmmmmm",
      nodeId: "nnnnnnnnnnnnnnnnnnnnnnnnnn",
      noisePub: "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
      environmentId: env,
      label: "Node",
      connectionId: id,
    });
    const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map([
        [env, { enabled: true, target, profile: Option.some(profile), alternateRoutes: [] }],
      ]),
    );
    const removed: string[] = [];
    const registered: string[] = [];
    const unused = () => Effect.die("unexpected registry call");
    const unusedStream = () => Stream.die("unexpected registry stream");
    const registry = EnvironmentRegistry.of({
      entries,
      networkStatus: yield* SubscriptionRef.make<"unknown" | "online" | "offline">("online"),
      start: Effect.void,
      register: (value) =>
        Effect.sync(() => {
          registered.push(
            value.profile._tag === "PenConnectionProfile" ? value.profile.noisePub : "",
          );
          return true;
        }),
      registerPlatform: unused,
      assertKnownAddress: unused,
      reconcilePlatform: unused,
      remove: unused,
      removeRoute: (_env, route) => Effect.sync(() => void removed.push(route)),
      reorderRoutes: unused,
      removeRelayEnvironments: unused,
      retryNow: unused,
      reconnect: unused,
      setEnabled: unused,
      setCompatibility: unused,
      state: unused,
      stateChanges: unusedStream,
      run: unused,
      runStream: unusedStream,
      followStream: unusedStream,
    });
    const member = (online: boolean) => ({
      nodeId: "nnnnnnnnnnnnnnnnnnnnnnnnnn",
      name: "Node",
      online,
      noisePub: "rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr",
      route: { kind: "refused" as const, reason: "not-pen-route" as const },
    });
    const ready = (online: boolean) => ({
      kind: "ready" as const,
      seq: 1,
      meshId: "mmmmmmmmmmmmmmmmmmmmmmmmmm",
      selfNodeId: "self",
      members: [member(online)],
    });
    const latest = yield* SubscriptionRef.make<Option.Option<PenMembersInput>>(
      Option.some(ready(false)),
    );
    yield* Effect.gen(function* () {
      const discovery = yield* makePenNativeDiscovery();
      // Still a member, under a new key: its environment and drafts stay.
      yield* discovery.pass(ready(false));
      expect(removed).toEqual([]);
      yield* SubscriptionRef.set(latest, Option.some(ready(true)));
      yield* discovery.pass(ready(true));
      expect(removed).toEqual([]);
      expect(registered).toEqual(["rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr"]);
    }).pipe(
      Effect.provideService(EnvironmentRegistry, registry),
      Effect.provideService(PenMembership, { latest, admit: () => Effect.void }),
      Effect.provideService(PenViewerPolicy, { enabled: true }),
      Effect.provideService(
        PenRouteGateway,
        Option.some({
          open: () =>
            Effect.succeed({
              kind: "open" as const,
              httpBaseUrl: `http://127.0.0.1/pen-route/${"a".repeat(43)}`,
              socketUrl: "ws://127.0.0.1/ws",
            }),
          close: () => Effect.void,
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                environmentId: "env",
                label: "Node",
                platform: { os: "darwin", arch: "arm64" },
                serverVersion: "1.0.0",
                capabilities: { repositoryIdentity: true },
              }),
            ),
          ),
        ),
      ),
    );
  }),
);
