// @effect-diagnostics nodeBuiltinImport:off -- a scratch state folder holds a fake control socket.
import * as NodeFSP from "node:fs/promises";
import type * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, type PenTrustRoot, type ServerSettings } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { penConnection } from "../auth/connectionContext.testkit.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { createGuardedHttpServer } from "../httpResponseErrorGuard.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as PenEnablement from "./PenEnablement.ts";
import { layerTest as layerEnablement } from "./PenEnablement.testkit.ts";
import { dial, http, member, peerOf, PIN, prove, response } from "./penDaemon.testkit.ts";
import { layerPenRouteGate, layerPenSessionRoute } from "./PenHttp.ts";
import type { PlatformProbe } from "./penPlatformGate.ts";
import { PenRegistrar } from "./PenRegistrar.ts";
import { MainHttpServer, make } from "./PenRuntime.ts";
import * as PenSessionsModule from "./PenSessions.ts";

const UID = 501;
/** Platform facts that pass the gate for \`root\` while \`state.safe\` holds. */
const probeFor = (root: PenTrustRoot, state: { safe: boolean }): PlatformProbe => ({
  platform: "darwin",
  uid: UID,
  realpath: async (path) => path,
  inspect: async (path) => {
    if (!state.safe) return { uid: 502, mode: 0o040777, kind: "directory" };
    if (path === root.executablePath) return { uid: 0, mode: 0o100755, kind: "file" };
    if (path === root.stateDir) return { uid: UID, mode: 0o040700, kind: "directory" };
    if (path === NodePath.join(root.stateDir, "control.sock"))
      return { uid: UID, mode: 0o140600, kind: "socket" };
    return { uid: 0, mode: 0o040755, kind: "directory" };
  },
});

interface Registration {
  readonly port: number;
  readonly key: Uint8Array;
  readonly lost: Deferred.Deferred<void>;
}

type Repository = AuthSessions.AuthSessionRepository["Service"];

const setup = (
  options: {
    readonly enabled?: boolean;
    readonly stored?: boolean;
    readonly repository?: (real: Repository) => Partial<Repository>;
  } = {},
) =>
  Effect.gen(function* () {
    const stateDir = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-pen-rt-"))),
      (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
    );
    const root: PenTrustRoot = {
      executablePath: "/opt/pen/bin/pen",
      stateDir,
      meshId: PIN.meshId,
      nodeId: PIN.nodeId,
    };
    const platform = { safe: true };
    const registrations = yield* Queue.unbounded<Registration>();
    const services = yield* Layer.build(
      PenSessionsModule.layer.pipe(
        Layer.provide(
          Layer.effect(
            AuthSessions.AuthSessionRepository,
            Effect.map(AuthSessions.make, (real) => ({ ...real, ...options.repository?.(real) })),
          ),
        ),
        Layer.provideMerge(options.enabled === false ? PenEnablement.layer : layerEnablement(true)),
        Layer.provideMerge(SessionStore.layer),
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provideMerge(
          Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make("pen-runtime-test")),
          }),
        ),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-pen-rt-" })),
        Layer.provideMerge(
          Settings.ServerSettingsService.layerTest(options.stored === true ? { pen: root } : {}),
        ),
      ),
    );
    let main: NodeHttp.Server | undefined;
    const seen: Array<string> = [];
    yield* Layer.build(
      HttpRouter.serve(
        Layer.mergeAll(
          layerPenRouteGate,
          layerPenSessionRoute,
          HttpRouter.add(
            "GET",
            "/api/projects",
            Effect.sync(() => {
              seen.push("projects");
              return HttpServerResponse.text("projects");
            }),
          ),
        ),
        { disableListenLog: true, disableLogger: true },
      ).pipe(
        Layer.provide(Layer.succeedContext(services)),
        Layer.provideMerge(
          NodeHttpServer.layer(
            () => {
              main = createGuardedHttpServer();
              return main;
            },
            { port: 0, host: "127.0.0.1" },
          ),
        ),
      ),
    );
    const mainServer = yield* Deferred.make<NodeHttp.Server>();
    yield* Deferred.succeed(mainServer, main!);
    /** Each registration takes the next hold, if any, after it is recorded. */
    const holds: Array<Deferred.Deferred<void>> = [];
    const register: PenRegistrar["Service"]["register"] = (input) =>
      Effect.gen(function* () {
        const lost = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(lost, undefined));
        yield* Queue.offer(registrations, { port: input.port, key: input.key, lost });
        const hold = holds.shift();
        if (hold !== undefined) yield* Deferred.await(hold);
        return { id: "registration", lost };
      });
    const startWith = (
      overrides: {
        readonly settings?: Settings.ServerSettingsService["Service"];
        readonly penSessions?: PenSessionsModule.PenSessions["Service"];
        readonly onTransitionWait?: Effect.Effect<void>;
      } = {},
    ) => {
      const runtime = make({
        probe: probeFor(root, platform),
        ...(overrides.onTransitionWait === undefined
          ? {}
          : { onTransitionWait: overrides.onTransitionWait }),
      }).pipe(
        Effect.provideService(PenRegistrar, { register }),
        Effect.provideService(MainHttpServer, { server: mainServer }),
      );
      const withSettings =
        overrides.settings === undefined
          ? runtime
          : runtime.pipe(Effect.provideService(Settings.ServerSettingsService, overrides.settings));
      const withSessions =
        overrides.penSessions === undefined
          ? withSettings
          : withSettings.pipe(
              Effect.provideService(PenSessionsModule.PenSessions, overrides.penSessions),
            );
      return withSessions.pipe(Effect.provide(services));
    };
    const start = startWith();
    return { root, platform, registrations, holds, services, start, startWith, seen };
  });

const proxyToken = (port: number, key: Uint8Array, nodeId: string) =>
  prove(port, nodeId, {
    key,
    after: http(
      "POST",
      "/api/pen/session",
      {},
      JSON.stringify({ kind: "proxy", scopes: ["orchestration:read"] }),
    ),
  }).pipe(
    Effect.flatMap(response),
    Effect.map((answer) => (JSON.parse(answer.body) as { readonly token: string }).token),
  );
const projects = (port: number, key: Uint8Array, nodeId: string, token: string) =>
  prove(port, nodeId, {
    key,
    after: http("GET", "/api/projects", { authorization: "Bearer " + token }),
  }).pipe(
    Effect.flatMap(response),
    Effect.map((answer) => answer.status),
  );
/** A Pen connection that stays open after one answered request. */
const keepAlive = (port: number, key: Uint8Array, nodeId: string, token: string) =>
  Effect.gen(function* () {
    const live = yield* prove(port, nodeId, {
      key,
      after:
        "GET /api/projects HTTP/1.1\r\nHost: pen\r\nAuthorization: Bearer " + token + "\r\n\r\n",
    });
    expect(yield* live.line()).toBe("HTTP/1.1 200 OK\r");
    return live;
  });
const sessionIdOf = (token: string, nodeId: string) =>
  Effect.gen(function* () {
    const sessions = yield* SessionStore.SessionStore;
    return (yield* sessions.verify(
      token,
      penConnection(peerOf(nodeId), { generation: -1 }).context,
    )).sessionId;
  });
/** Pen's control socket in a scratch state folder, answering watch.snapshot with what a test sends. */
const controlSocket = (stateDir: string) =>
  Effect.gen(function* () {
    const watchers: Array<NodeNet.Socket> = [];
    const watching = yield* Deferred.make<void>();
    const control = NodeNet.createServer((socket) => {
      socket.on("error", () => {});
      socket.once("data", (request) => {
        expect(request.toString()).toBe('{"op":"watch.snapshot"}\n');
        watchers.push(socket);
        Deferred.doneUnsafe(watching, Effect.void);
      });
    });
    yield* Effect.acquireRelease(
      Effect.callback<void>((resume) => {
        control.listen(NodePath.join(stateDir, "control.sock"), () => resume(Effect.void));
      }),
      () => Effect.sync(() => control.close()),
    );
    const send = (line: string) =>
      Effect.sync(() => {
        for (const socket of watchers) socket.write(line + "\n");
      });
    return { watching, send };
  });
const snapshot = (gen: number, mesh: string, members: ReadonlyArray<string>) =>
  JSON.stringify({
    t: "snapshot",
    gen,
    mesh,
    self: PIN.nodeId,
    members: members.map((nodeId) => ({ ...peerOf(nodeId), user: "", hostKeys: [], online: true })),
    revoked: [],
  });
const person = { principalKind: "person" } as const;

it.layer(NodeServices.layer)("PenRuntime (mesh link design §7)", (it) => {
  it.effect(
    "the build's closed gate starts nothing from a stored root and refuses confirmation",
    () =>
      Effect.gen(function* () {
        const env = yield* setup({ enabled: false, stored: true });
        const runtime = yield* env.start;
        expect(yield* runtime.status).toMatchObject({ state: "off" });
        expect(yield* Queue.size(env.registrations)).toBe(0);
        expect((yield* Effect.flip(runtime.replaceTrustRoot(person, env.root))).reason).toBe(
          "Pen is not enabled in this build.",
        );
        expect(yield* Queue.size(env.registrations)).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.effect("only a person confirms; then GOAT registers its key and serves a proven member", () =>
    Effect.gen(function* () {
      const env = yield* setup();
      const runtime = yield* env.start;
      for (const principalKind of ["outside_client", "proxied_person"] as const)
        expect(
          (yield* Effect.flip(runtime.replaceTrustRoot({ principalKind }, env.root))).reason,
        ).toBe("Only a person confirms the Pen trust root.");
      expect(yield* Queue.size(env.registrations)).toBe(0);
      yield* runtime.replaceTrustRoot(person, env.root);
      const registration = yield* Queue.take(env.registrations);
      expect(yield* runtime.status).toMatchObject({ state: "listening", port: registration.port });
      expect(
        (yield* Settings.ServerSettingsService.pipe(
          Effect.flatMap((s) => s.getSettings),
          Effect.provide(env.services),
        )).pen,
      ).toEqual(env.root);
      const token = yield* proxyToken(registration.port, registration.key, member("a"));
      expect(yield* projects(registration.port, registration.key, member("a"), token)).toBe(200);
      expect(env.seen).toEqual(["projects"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a root change closes live Pen connections and revokes every member session", () =>
    Effect.gen(function* () {
      const env = yield* setup();
      const runtime = yield* env.start;
      yield* runtime.replaceTrustRoot(person, env.root);
      const first = yield* Queue.take(env.registrations);
      const token = yield* proxyToken(first.port, first.key, member("a"));
      const sessionId = yield* sessionIdOf(token, member("a")).pipe(Effect.provide(env.services));
      const live = yield* keepAlive(first.port, first.key, member("a"), token);
      yield* runtime.replaceTrustRoot(person, { ...env.root, nodeId: member("q") });
      yield* Deferred.await(live.closed);
      yield* Deferred.await(first.lost);
      yield* SessionStore.SessionStore.pipe(
        Effect.flatMap((sessions) => sessions.awaitInvalidation(sessionId)),
        Effect.provide(env.services),
      );
      const second = yield* Queue.take(env.registrations);
      expect(Buffer.from(second.key).equals(Buffer.from(first.key))).toBe(false);
      yield* runtime.replaceTrustRoot(person, null);
      yield* Deferred.await(second.lost);
      expect(yield* runtime.status).toMatchObject({ state: "off" });
    }).pipe(Effect.scoped),
  );

  it.effect("a Pen path that turns unsafe ends the generation at the next accept", () =>
    Effect.gen(function* () {
      const env = yield* setup();
      const runtime = yield* env.start;
      yield* runtime.replaceTrustRoot(person, env.root);
      const registration = yield* Queue.take(env.registrations);
      const token = yield* proxyToken(registration.port, registration.key, member("a"));
      const live = yield* keepAlive(registration.port, registration.key, member("a"), token);
      env.platform.safe = false;
      const refused = yield* dial(registration.port);
      yield* Deferred.await(refused.closed);
      expect(refused.received()).toBe("");
      yield* Deferred.await(registration.lost);
      yield* Deferred.await(live.closed);
      expect(yield* runtime.status).toMatchObject({ state: "off" });
      expect((yield* Effect.flip(runtime.replaceTrustRoot(person, env.root))).reason).toContain(
        "writable by another user",
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "startup revokes every Pen-bound session before accepting, and starts from a stored root",
    () =>
      Effect.gen(function* () {
        const env = yield* setup({ stored: true });
        const stale = yield* SessionStore.SessionStore.pipe(
          Effect.flatMap((sessions) =>
            sessions.issue({
              subject: "mcp-client",
              method: "bearer-access-token",
              scopes: ["orchestration:read"],
              principalKind: "outside_client",
              penBinding: { meshId: PIN.meshId, nodeId: member("a"), signPub: "s", noisePub: "n" },
            }),
          ),
          Effect.provide(env.services),
        );
        yield* env.start;
        yield* SessionStore.SessionStore.pipe(
          Effect.flatMap((sessions) => sessions.awaitInvalidation(stale.sessionId)),
          Effect.provide(env.services),
        );
        expect((yield* Queue.take(env.registrations)).port).toBeGreaterThan(0);
      }).pipe(Effect.scoped),
  );

  it.effect("Pen dropping GOAT's registration ends the generation", () =>
    Effect.gen(function* () {
      const env = yield* setup();
      const runtime = yield* env.start;
      yield* runtime.replaceTrustRoot(person, env.root);
      const registration = yield* Queue.take(env.registrations);
      const token = yield* proxyToken(registration.port, registration.key, member("a"));
      const sessionId = yield* sessionIdOf(token, member("a")).pipe(Effect.provide(env.services));
      yield* Deferred.succeed(registration.lost, undefined);
      yield* SessionStore.SessionStore.pipe(
        Effect.flatMap((sessions) => sessions.awaitInvalidation(sessionId)),
        Effect.provide(env.services),
      );
      expect(yield* runtime.status).toMatchObject({ state: "off" });
    }).pipe(Effect.scoped),
  );

  it.effect(
    "the member watch revokes a departed member's sessions and fences on another mesh",
    () =>
      Effect.gen(function* () {
        const env = yield* setup();
        const { watching, send } = yield* controlSocket(env.root.stateDir);
        const runtime = yield* env.start;
        yield* runtime.replaceTrustRoot(person, env.root);
        const registration = yield* Queue.take(env.registrations);
        const tokenA = yield* proxyToken(registration.port, registration.key, member("a"));
        const tokenB = yield* proxyToken(registration.port, registration.key, member("b"));
        const idA = yield* sessionIdOf(tokenA, member("a")).pipe(Effect.provide(env.services));
        const idB = yield* sessionIdOf(tokenB, member("b")).pipe(Effect.provide(env.services));
        yield* Deferred.await(watching);
        yield* send(snapshot(7, PIN.meshId, [PIN.nodeId, member("a")]));
        yield* SessionStore.SessionStore.pipe(
          Effect.flatMap((sessions) => sessions.awaitInvalidation(idB)),
          Effect.provide(env.services),
        );
        expect(yield* projects(registration.port, registration.key, member("a"), tokenA)).toBe(200);
        yield* send(snapshot(8, member("n"), [PIN.nodeId, member("a")]));
        yield* Deferred.await(registration.lost);
        yield* SessionStore.SessionStore.pipe(
          Effect.flatMap((sessions) => sessions.awaitInvalidation(idA)),
          Effect.provide(env.services),
        );
        expect(yield* runtime.status).toMatchObject({ state: "off" });
      }).pipe(Effect.scoped),
  );

  it.effect("a departed member whose sessions cannot be withdrawn ends the generation", () =>
    Effect.gen(function* () {
      let failing = false;
      const env = yield* setup({
        repository: (real) => ({
          listPenBound: (input) =>
            failing
              ? Effect.fail(new PersistenceSqlError({ operation: "listPenBound", detail: "disk" }))
              : real.listPenBound(input),
        }),
      });
      const { watching, send } = yield* controlSocket(env.root.stateDir);
      const runtime = yield* env.start;
      yield* runtime.replaceTrustRoot(person, env.root);
      const registration = yield* Queue.take(env.registrations);
      yield* proxyToken(registration.port, registration.key, member("b"));
      yield* Deferred.await(watching);
      failing = true;
      yield* send(snapshot(1, PIN.meshId, [PIN.nodeId]));
      yield* Deferred.await(registration.lost);
      // A confirmation queues behind the fence and finds the withdrawal still owed.
      expect((yield* Effect.flip(runtime.replaceTrustRoot(person, env.root))).reason).toContain(
        "could not all be withdrawn",
      );
      expect(yield* Queue.size(env.registrations)).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "an issue held inside the lock when the root changes is revoked by the fence; later issues are refused",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let hold = false;
        const env = yield* setup({
          repository: (real) => ({
            deleteInactivePenBound: (input) =>
              hold
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(real.deleteInactivePenBound(input)),
                  )
                : real.deleteInactivePenBound(input),
          }),
        });
        const runtime = yield* env.start;
        yield* runtime.replaceTrustRoot(person, env.root);
        const registration = yield* Queue.take(env.registrations);
        const pen = yield* PenSessionsModule.PenSessions.pipe(Effect.provide(env.services));
        const status = yield* runtime.status;
        const generation = status.state === "listening" ? status.generation : -1;
        const connection = penConnection(peerOf(member("a")), { generation });
        hold = true;
        const held = yield* pen
          .issue(
            connection.context,
            JSON.stringify({ kind: "proxy", scopes: ["orchestration:read"] }),
          )
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(entered);
        hold = false;
        const replacing = yield* runtime
          .replaceTrustRoot(person, null)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.succeed(release, undefined);
        const issued = yield* Fiber.join(held);
        yield* Fiber.join(replacing);
        yield* Deferred.await(registration.lost);
        const sessions = yield* SessionStore.SessionStore.pipe(Effect.provide(env.services));
        const exit = yield* Effect.exit(sessions.verify(issued.token, connection.context));
        expect(Exit.isFailure(exit)).toBe(true);
        expect(
          (yield* Effect.flip(
            pen.issue(
              connection.context,
              JSON.stringify({ kind: "proxy", scopes: ["orchestration:read"] }),
            ),
          )).code,
        ).toBe("refused");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a hand-edited root fences the live generation and stays off until a person confirms",
    () =>
      Effect.gen(function* () {
        const env = yield* setup();
        const changes = yield* Queue.unbounded<ServerSettings>();
        const base = yield* Settings.ServerSettingsService.pipe(Effect.provide(env.services));
        const runtime = yield* env.startWith({
          settings: {
            ...base,
            streamChanges: Stream.fromQueue(changes),
            subscribeChanges: Effect.succeed(Stream.fromQueue(changes)),
          },
        });
        yield* runtime.replaceTrustRoot(person, env.root);
        const first = yield* Queue.take(env.registrations);
        const current = yield* base.getSettings;
        const edited = { ...env.root, nodeId: member("q") };
        yield* Queue.offer(changes, current);
        // A hand edit changes what is stored, then a notification arrives.
        yield* base.updateSettings({ pen: edited });
        yield* Queue.offer(changes, { ...current, pen: edited });
        yield* Deferred.await(first.lost);
        expect(yield* runtime.status).toMatchObject({ state: "off" });
        // A confirmation waits behind the edit's own transition, so only it may register.
        yield* runtime.replaceTrustRoot(person, edited);
        expect((yield* Queue.take(env.registrations)).port).toBeGreaterThan(0);
        expect(yield* Queue.size(env.registrations)).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.effect("an edit stored while startup registers fences that generation once startup ends", () =>
    Effect.gen(function* () {
      const env = yield* setup({ stored: true });
      const hold = yield* Deferred.make<void>();
      env.holds.push(hold);
      const base = yield* Settings.ServerSettingsService.pipe(Effect.provide(env.services));
      const starting = yield* env.start.pipe(Effect.forkScoped({ startImmediately: true }));
      const first = yield* Queue.take(env.registrations);
      // The test settings publish no notification, so only startup's own reconcile can see this.
      yield* base.updateSettings({ pen: { ...env.root, nodeId: member("q") } });
      yield* Deferred.succeed(hold, undefined);
      const runtime = yield* Fiber.join(starting);
      expect(yield* Deferred.isDone(first.lost)).toBe(true);
      expect(yield* runtime.status).toMatchObject({ state: "off" });
      expect(yield* Queue.size(env.registrations)).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("confirmations run one at a time and leave only the last confirmed root running", () =>
    Effect.gen(function* () {
      const env = yield* setup();
      const entered = yield* Deferred.make<void>();
      const hold = yield* Deferred.make<void>();
      const waits = yield* Queue.unbounded<string>();
      const base = yield* Settings.ServerSettingsService.pipe(Effect.provide(env.services));
      const pen = yield* PenSessionsModule.PenSessions.pipe(Effect.provide(env.services));
      const runtime = yield* env.startWith({
        // A pauses inside its own settings write, after its fence and before its start.
        settings: {
          ...base,
          updateSettings: (patch, authorize) =>
            patch.pen?.nodeId === env.root.nodeId
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(hold)),
                  Effect.andThen(base.updateSettings(patch, authorize)),
                )
              : base.updateSettings(patch, authorize),
        },
        // Wherever B has to wait (the transition, or the issue lock), it is queued before A goes on.
        onTransitionWait: Queue.offer(waits, "transition").pipe(Effect.asVoid),
        penSessions: {
          ...pen,
          withIssueLock: (effect) =>
            Queue.offer(waits, "issue lock").pipe(
              Effect.andThen(pen.withIssueLock(effect)),
              // Hand a released lock to whoever is queued for it, as a busy scheduler may.
              Effect.tap(() => Effect.yieldNow),
            ),
        },
      });
      const confirmA = yield* runtime
        .replaceTrustRoot(person, env.root)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(entered);
      yield* Queue.clear(waits);
      const confirmB = yield* runtime
        .replaceTrustRoot(person, { ...env.root, nodeId: member("q") })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Queue.take(waits);
      yield* Deferred.succeed(hold, undefined);
      yield* Fiber.join(confirmA);
      yield* Fiber.join(confirmB);
      const first = yield* Queue.take(env.registrations);
      const last = yield* Queue.take(env.registrations);
      expect(yield* Deferred.isDone(first.lost)).toBe(true);
      expect(yield* Deferred.isDone(last.lost)).toBe(false);
      expect(yield* runtime.status).toMatchObject({ state: "listening", port: last.port });
      expect(yield* Queue.size(env.registrations)).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("a late notification of an earlier confirmation does not fence the newer one", () =>
    Effect.gen(function* () {
      const env = yield* setup();
      const changes = yield* Queue.unbounded<ServerSettings>();
      const waits = yield* Queue.unbounded<void>();
      const base = yield* Settings.ServerSettingsService.pipe(Effect.provide(env.services));
      const runtime = yield* env.startWith({
        settings: {
          ...base,
          streamChanges: Stream.fromQueue(changes),
          subscribeChanges: Effect.succeed(Stream.fromQueue(changes)),
        },
        onTransitionWait: Queue.offer(waits, undefined).pipe(Effect.asVoid),
      });
      yield* runtime.replaceTrustRoot(person, env.root);
      const a = yield* Queue.take(env.registrations);
      const atA = yield* base.getSettings;
      yield* runtime.replaceTrustRoot(person, { ...env.root, nodeId: member("q") });
      const b = yield* Queue.take(env.registrations);
      yield* Deferred.await(a.lost);
      yield* Queue.clear(waits);
      yield* Queue.offer(changes, atA);
      yield* Queue.offer(changes, yield* base.getSettings);
      // The handler takes one notification at a time: the second wait means the first is done.
      yield* Queue.take(waits);
      yield* Queue.take(waits);
      expect(yield* Deferred.isDone(b.lost)).toBe(false);
      expect(yield* runtime.status).toMatchObject({ state: "listening", port: b.port });
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a revocation that fails keeps Pen off until it succeeds; the old token stays dead",
    () =>
      Effect.gen(function* () {
        let failing = false;
        const env = yield* setup({
          repository: (real) => ({
            listPenBound: (input) =>
              failing
                ? Effect.fail(
                    new PersistenceSqlError({ operation: "listPenBound", detail: "disk" }),
                  )
                : real.listPenBound(input),
          }),
        });
        const runtime = yield* env.start;
        yield* runtime.replaceTrustRoot(person, env.root);
        const first = yield* Queue.take(env.registrations);
        const token = yield* proxyToken(first.port, first.key, member("a"));
        const sessionId = yield* sessionIdOf(token, member("a")).pipe(Effect.provide(env.services));
        failing = true;
        expect((yield* Effect.flip(runtime.replaceTrustRoot(person, null))).reason).toContain(
          "could not all be withdrawn",
        );
        yield* Deferred.await(first.lost);
        expect(yield* runtime.status).toMatchObject({
          state: "off",
          reason: expect.stringContaining("could not all be withdrawn"),
        });
        expect((yield* Effect.flip(runtime.replaceTrustRoot(person, env.root))).reason).toContain(
          "could not all be withdrawn",
        );
        expect(yield* Queue.size(env.registrations)).toBe(0);
        failing = false;
        yield* runtime.replaceTrustRoot(person, env.root);
        const second = yield* Queue.take(env.registrations);
        yield* SessionStore.SessionStore.pipe(
          Effect.flatMap((sessions) => sessions.awaitInvalidation(sessionId)),
          Effect.provide(env.services),
        );
        expect(yield* projects(second.port, second.key, member("a"), token)).toBe(401);
      }).pipe(Effect.scoped),
  );

  it.effect("a hand edit that races a confirmation is fenced after it, not started", () =>
    Effect.gen(function* () {
      const env = yield* setup();
      const hold = yield* Deferred.make<void>();
      env.holds.push(hold);
      const changes = yield* Queue.unbounded<ServerSettings>();
      const base = yield* Settings.ServerSettingsService.pipe(Effect.provide(env.services));
      const runtime = yield* env.startWith({
        settings: {
          ...base,
          streamChanges: Stream.fromQueue(changes),
          subscribeChanges: Effect.succeed(Stream.fromQueue(changes)),
        },
      });
      const confirm = yield* runtime
        .replaceTrustRoot(person, env.root)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      const a = yield* Queue.take(env.registrations);
      const current = yield* base.getSettings;
      // The edit lands while A is still starting, after A stored its root.
      yield* base.updateSettings({ pen: { ...env.root, nodeId: member("q") } });
      yield* Queue.offer(changes, { ...current, pen: { ...env.root, nodeId: member("q") } });
      yield* Deferred.succeed(hold, undefined);
      yield* Fiber.join(confirm);
      yield* Deferred.await(a.lost);
      // Clearing waits behind the edit's transition; nothing the edit named may have registered.
      yield* runtime.replaceTrustRoot(person, null);
      expect(yield* runtime.status).toMatchObject({ state: "off" });
      expect(yield* Queue.size(env.registrations)).toBe(0);
    }).pipe(Effect.scoped),
  );
});
