import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthStandardClientScopes,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type ScreenRunResult,
} from "@goat/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts/settings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";
import { HttpServerRequest } from "effect/http";
import { layerTestLoopback } from "@goat/shared/testing/loopbackHttpServer";

import type { ConnectionContext } from "../auth/connectionContext.ts";
import { MAIN_LISTENER, onConnection, penConnection } from "../auth/connectionContext.testkit.ts";
import {
  layerHubAccess,
  makeCheckProbe,
  makeServerAndCli,
} from "../auth/DurableRevocations.testkit.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as EnvironmentAuthPolicy from "../auth/EnvironmentAuthPolicy.ts";
import * as McpOAuth from "../auth/McpOAuth.ts";
import { mcpClientScopes } from "../auth/mcpClientScopes.ts";
import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Project from "../project/ProjectService.ts";
import * as ScreenRunService from "../screenCode/ScreenRunService.ts";
import * as Settings from "../serverSettings.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import { catalog, dependencies, serveOverHttp } from "./agentSurface.testkit.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import {
  idleThreadProjection,
  layerPermissionProfilesOff,
  liveThreadShell,
} from "./McpToolAccess.testkit.ts";

const layerAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(Sqlite.layerMemory),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-mcp-cut-" })),
  Layer.provideMerge(NodeServices.layer),
);
const environmentId = EnvironmentId.make("environment");
const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "session-cut-test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "session-cut-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

/** What the gated services saw: admitted calls park on the gate until the test opens it. */
const makeProbe = Effect.all({
  admitted: Deferred.make<void>(),
  gate: Deferred.make<void>(),
  stopped: Deferred.make<void>(),
  landed: Ref.make<ReadonlyArray<string>>([]),
  arrived: Queue.unbounded<string>(),
});
type Probe = Effect.Success<typeof makeProbe>;
const gated = <A>(probe: Probe, name: string, value: A) =>
  Effect.gen(function* () {
    if (name.startsWith("gated")) {
      yield* Deferred.succeed(probe.admitted, undefined);
      yield* Queue.offer(probe.arrived, name);
      yield* Deferred.await(probe.gate);
    }
    yield* Ref.update(probe.landed, (landed) => [...landed, name]);
    return value;
  }).pipe(Effect.onInterrupt(() => Deferred.succeed(probe.stopped, undefined)));

const projectRegistrations = (probe: Probe) =>
  Layer.mergeAll(
    McpHttpServer.catalogRegistrations.project,
    McpHttpServer.catalogRegistrations.agentSurface,
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        dependencies,
        Sqlite.layerMemory,
        Layer.mock(Project.ProjectService)({
          create: (input) =>
            gated(probe, input.title, {
              id: input.projectId,
              title: input.title,
              workspaceRoot: input.workspaceRoot,
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-11-17T00:00:00.000Z",
              updatedAt: "2026-11-17T00:00:00.000Z",
              deletedAt: null,
            }),
        }),
      ),
    ),
  );
const served = (probe: Probe) =>
  projectRegistrations(probe).pipe(Layer.provideMerge(McpServer.McpServer.layer));

/** The scope /mcp builds for a bearer token arriving on `connection`. */
const authenticate = (
  auth: EnvironmentAuth.EnvironmentAuth["Service"],
  token: string,
  connection: ConnectionContext = MAIN_LISTENER,
) =>
  Effect.gen(function* () {
    const clients = yield* McpHttpServer.McpClientAuthenticator;
    const request = new Request("http://127.0.0.1/mcp", {
      headers: { host: "box.example.ts.net", authorization: "Bearer " + token },
    });
    const scope = yield* clients.authenticate(
      onConnection(HttpServerRequest.fromWeb(request), connection),
    );
    if (scope === undefined) return yield* Effect.die("the MCP client did not authenticate");
    return scope;
  }).pipe(
    Effect.provide(
      McpOAuth.layerMcpClientAuthenticator.pipe(
        Layer.provide(Layer.succeed(EnvironmentAuth.EnvironmentAuth, auth)),
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(environmentId),
          }),
        ),
      ),
    ),
  );

/** An MCP client signed in for an hour; its scope is what /mcp builds from its bearer token. */
const signIn = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const issued = yield* auth.issueSession({
    subject: "mcp-client",
    label: "Outside agent",
    scopes: mcpClientScopes("full-access"),
    runtimeModeCeiling: "full-access",
    ttl: Duration.hours(1),
  });
  const scope = yield* authenticate(auth, issued.token);
  const settings = yield* auth.issueSession({
    subject: "settings-page",
    scopes: AuthStandardClientScopes,
  });
  return {
    scope,
    sessionId: issued.sessionId,
    revoke: auth.revokeClientSession(settings.sessionId, issued.sessionId),
    revokeOthers: auth.revokeOtherClientSessions(settings.sessionId),
  };
});

const call = (
  scope: McpInvocationContext.McpInvocationScope,
  name: string,
  args: Readonly<Record<string, unknown>>,
) =>
  Effect.flatMap(McpServer.McpServer, (server) => server.callTool({ name, arguments: args })).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );
const textOf = (result: McpSchema.CallToolResult) =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
/** One message for every tool, read or write, since a tool's read-only hint is not proof it wrote nothing. */
const CUT =
  "This GOAT session was revoked while the call ran, so GOAT stopped it. If the call changes anything, part of it may already have happened; check before repeating it with a new sign-in.";
const create = (title: string) => ({ title, workspaceRoot: "/tmp/goat-session-cut/" + title });

it.effect.each(["Settings revoke", "Revoke others"] as const)(
  "a project create admitted before a %s never lands and returns the cut",
  (path) =>
    Effect.gen(function* () {
      const probe = yield* makeProbe;
      const client = yield* signIn;
      yield* Effect.gen(function* () {
        const running = yield* call(client.scope, "goat_project_create", create("gated")).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(probe.admitted);
        yield* path === "Settings revoke" ? client.revoke : client.revokeOthers;
        yield* Deferred.succeed(probe.gate, undefined);
        const result = yield* Fiber.join(running);
        expect(yield* Ref.get(probe.landed)).toEqual([]);
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain(CUT);
        expect(result._meta).toBeUndefined();
      }).pipe(Effect.provide(served(probe)));
    }).pipe(Effect.provide(layerAuth)),
);

const peer = {
  meshId: "mesh-1",
  nodeId: "node-a",
  signPub: "sign-a",
  noisePub: "noise-a",
  name: "a",
} as const;
/** EnvironmentAuth over the server's store on disk, which a second store (the CLI) shares. */
const layerAuthOver = <E, R>(
  running: Layer.Layer<SessionStore.SessionStore | SqlClient.SqlClient, E, R>,
) =>
  Layer.effect(EnvironmentAuth.EnvironmentAuth, EnvironmentAuth.make).pipe(
    Layer.provide(EnvironmentAuthPolicy.layer),
    Layer.provide(PairingGrantStore.layer),
    Layer.provide(layerHubAccess),
    Layer.provideMerge(running),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-mcp-cut-disk-" })),
  );

it.effect.each(["revoked by the command line", "Pen-bound and its row is deleted"] as const)(
  "a project create admitted before its session is %s never lands once the durable check runs",
  (ending) =>
    Effect.gen(function* () {
      const check = yield* makeCheckProbe;
      const probe = yield* makeProbe;
      const { running, fromCli } = yield* makeServerAndCli(check.wrap);
      yield* Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const store = yield* SessionStore.SessionStore;
        const sql = yield* SqlClient.SqlClient;
        // Keeps a session live so the check reads and proves this one ended.
        yield* store.issue({ scopes: ["memory:read"] });
        const client =
          ending === "revoked by the command line"
            ? yield* signIn
            : yield* Effect.gen(function* () {
                const issued = yield* store.issue({
                  subject: "mcp-client",
                  method: "bearer-access-token",
                  scopes: mcpClientScopes("full-access"),
                  runtimeModeCeiling: "full-access",
                  principalKind: "outside_client",
                  penBinding: {
                    meshId: peer.meshId,
                    nodeId: peer.nodeId,
                    signPub: peer.signPub,
                    noisePub: peer.noisePub,
                  },
                });
                const scope = yield* authenticate(auth, issued.token, penConnection(peer).context);
                return { scope, sessionId: issued.sessionId };
              });
        const running = yield* call(client.scope, "goat_project_create", create("gated")).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(probe.admitted);
        if (ending === "revoked by the command line")
          yield* fromCli((cli) => cli.revoke(client.sessionId));
        else yield* sql`DELETE FROM auth_sessions WHERE session_id = ${client.sessionId}`;
        expect(yield* check.next).toBe("read");
        yield* Deferred.succeed(probe.gate, undefined);
        const result = yield* Fiber.join(running);
        expect(yield* Ref.get(probe.landed)).toEqual([]);
        expect(textOf(result)).toContain(CUT);
      }).pipe(
        // Built in order: the disk store opens before the served catalog's own in-memory database.
        Effect.provide(served(probe).pipe(Layer.provideMerge(layerAuthOver(running)))),
        Effect.scoped,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "Revoke others keeps a kept Pen session's call and grant and cuts a revoked one's; a later check that settles the revoked id again changes nothing",
  () =>
    Effect.gen(function* () {
      const check = yield* makeCheckProbe;
      const probe = yield* makeProbe;
      // Each durable read: the ids the check held live, and those its rows still showed unrevoked.
      const reads: Array<{ live: ReadonlyArray<string>; unrevoked: ReadonlyArray<string> }> = [];
      const { running } = yield* makeServerAndCli((repository) =>
        check.wrap({
          ...repository,
          listUnrevoked: (input) =>
            repository
              .listUnrevoked(input)
              .pipe(
                Effect.tap((unrevoked) =>
                  Effect.sync(() => reads.push({ live: input.sessionIds, unrevoked })),
                ),
              ),
        }),
      );
      yield* Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const store = yield* SessionStore.SessionStore;
        const revoked = yield* signIn;
        const pen = yield* store.issue({
          subject: "mcp-client",
          method: "bearer-access-token",
          scopes: mcpClientScopes("full-access"),
          runtimeModeCeiling: "full-access",
          principalKind: "outside_client",
          penBinding: {
            meshId: peer.meshId,
            nodeId: peer.nodeId,
            signPub: peer.signPub,
            noisePub: peer.noisePub,
          },
        });
        const kept = yield* authenticate(auth, pen.token, penConnection(peer).context);
        const keptCall = yield* call(kept, "goat_project_create", create("gated-kept")).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const revokedCall = yield* call(
          revoked.scope,
          "goat_project_create",
          create("gated-revoked"),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Queue.take(probe.arrived);
        yield* Queue.take(probe.arrived);
        // A durable check snapshots both ids before the press and settles the revoked one again.
        yield* check.pass(revoked.revokeOthers);
        const settledAgain = reads.at(-1);
        // Checks run one after another, so this read returning means the one above settled.
        expect(yield* check.next).toBe("read");
        expect(settledAgain?.live).toContain(revoked.sessionId);
        expect(settledAgain?.unrevoked).not.toContain(revoked.sessionId);
        yield* Deferred.succeed(probe.gate, undefined);
        const keptResult = yield* Fiber.join(keptCall);
        const revokedResult = yield* Fiber.join(revokedCall);
        expect(yield* Ref.get(probe.landed)).toEqual(["gated-kept"]);
        expect(keptResult.isError).not.toBe(true);
        expect(keptResult.structuredContent).toMatchObject({ title: "gated-kept" });
        expect(textOf(revokedResult)).toContain(CUT);
        const grant = (sessionId: typeof pen.sessionId) =>
          store
            .readActiveScopes(sessionId)
            .pipe(Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "live" }));
        expect(yield* grant(pen.sessionId)).toBe("live");
        expect(yield* grant(revoked.sessionId)).not.toBe("live");
      }).pipe(
        Effect.provide(served(probe).pipe(Layer.provideMerge(layerAuthOver(running)))),
        Effect.scoped,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "a request verified before its session is revoked never runs, even after a second removal of 10,001 others",
  () =>
    Effect.gen(function* () {
      const probe = yield* makeProbe;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const client = yield* signIn;
      for (let index = 0; index < 10_001; index++)
        yield* auth.issueSession({ subject: "bulk", scopes: ["orchestration:read"] });
      yield* client.revoke;
      // A second removal, larger than any count a forgetful record could keep.
      yield* client.revokeOthers;
      yield* Effect.gen(function* () {
        const result = yield* call(client.scope, "goat_project_create", create("after-removals"));
        expect(yield* Ref.get(probe.landed)).toEqual([]);
        expect(textOf(result)).toContain(CUT);
      }).pipe(Effect.provide(served(probe)));
    }).pipe(Effect.provide(layerAuth)),
);

/** Pauses the next armed session read until the gate opens: a verify that has read the row. */
const makeVerifyPause = Effect.gen(function* () {
  const reached = yield* Deferred.make<void>();
  const gate = yield* Deferred.make<void>();
  let armed = false;
  const wrap = (repository: AuthSessions.AuthSessionRepository["Service"]) => ({
    ...repository,
    getById: (input: Parameters<typeof repository.getById>[0]) =>
      repository.getById(input).pipe(
        Effect.tap(() =>
          Effect.suspend(() => {
            if (!armed) return Effect.void;
            armed = false;
            return Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(gate)));
          }),
        ),
      ),
  });
  return {
    wrap,
    arm: Effect.sync(() => {
      armed = true;
    }),
    reached: Deferred.await(reached),
    open: Deferred.succeed(gate, undefined),
  };
});

it.effect(
  "a session revoked after its request's verify read the row, before it finished, never runs",
  () =>
    Effect.gen(function* () {
      const pause = yield* makeVerifyPause;
      const probe = yield* makeProbe;
      const { running } = yield* makeServerAndCli(pause.wrap);
      yield* Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const store = yield* SessionStore.SessionStore;
        const issued = yield* store.issue({
          subject: "mcp-client",
          method: "bearer-access-token",
          scopes: mcpClientScopes("full-access"),
          runtimeModeCeiling: "full-access",
        });
        yield* pause.arm;
        const verifying = yield* authenticate(auth, issued.token).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* pause.reached;
        yield* store.revoke(issued.sessionId);
        yield* pause.open;
        const scope = yield* Fiber.join(verifying);
        const result = yield* call(scope, "goat_project_create", create("raced"));
        expect(yield* Ref.get(probe.landed)).toEqual([]);
        expect(textOf(result)).toContain(CUT);
      }).pipe(
        Effect.provide(served(probe).pipe(Layer.provideMerge(layerAuthOver(running)))),
        Effect.scoped,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "a session whose last connection closes after it expired does not cut its running call",
  () =>
    Effect.gen(function* () {
      const probe = yield* makeProbe;
      const store = yield* SessionStore.SessionStore;
      const client = yield* signIn;
      yield* Effect.gen(function* () {
        yield* store.markConnected(client.sessionId);
        const running = yield* call(client.scope, "goat_project_create", create("gated")).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(probe.admitted);
        yield* TestClock.adjust(Duration.hours(2));
        // The connection closes at expiry; the session ends, but nothing revoked it.
        yield* store.markDisconnected(client.sessionId);
        yield* Deferred.succeed(probe.gate, undefined);
        const result = yield* Fiber.join(running);
        expect(yield* Ref.get(probe.landed)).toEqual(["gated"]);
        expect(textOf(result)).not.toContain(CUT);
      }).pipe(Effect.provide(served(probe)));
    }).pipe(Effect.provide(layerAuth)),
);

it.effect("an eval cut during one step never runs its next step", () =>
  Effect.gen(function* () {
    const probe = yield* makeProbe;
    const client = yield* signIn;
    yield* Effect.gen(function* () {
      const program =
        '(seq (project.create :title "gated-first" :workspaceRoot "/tmp/goat-session-cut/a")' +
        ' (project.create :title "second" :workspaceRoot "/tmp/goat-session-cut/b"))';
      const running = yield* call(client.scope, "goat_eval", { program }).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(probe.admitted);
      yield* client.revoke;
      yield* Deferred.succeed(probe.gate, undefined);
      const result = yield* Fiber.join(running);
      expect(yield* Ref.get(probe.landed)).toEqual([]);
      expect(textOf(result)).toContain(CUT);
    }).pipe(Effect.provide(served(probe)));
  }).pipe(Effect.provide(layerAuth)),
);

it.effect(
  "a call whose session was revoked before it started is cut without running; one whose session expired runs, as before",
  () =>
    Effect.gen(function* () {
      const probe = yield* makeProbe;
      const revoked = yield* signIn;
      const expired = yield* signIn;
      yield* revoked.revoke;
      yield* TestClock.adjust(Duration.hours(1));
      yield* Effect.gen(function* () {
        const cut = yield* call(revoked.scope, "goat_project_create", create("free-revoked"));
        expect(textOf(cut)).toContain(CUT);
        // The request was admitted before the expiry; a new request after it gets 401 at /mcp.
        const ran = yield* call(expired.scope, "goat_project_create", create("free-expired"));
        expect(textOf(ran)).not.toContain(CUT);
        expect(yield* Ref.get(probe.landed)).toEqual(["free-expired"]);
      }).pipe(Effect.provide(served(probe)));
    }).pipe(Effect.provide(layerAuth)),
);

it.effect("a running call outlives its session's expiry and lands, as before this change", () =>
  Effect.gen(function* () {
    const probe = yield* makeProbe;
    const client = yield* signIn;
    yield* Effect.gen(function* () {
      const running = yield* call(client.scope, "goat_project_create", create("gated")).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(probe.admitted);
      yield* TestClock.adjust(Duration.hours(1));
      yield* Deferred.succeed(probe.gate, undefined);
      const result = yield* Fiber.join(running);
      expect(yield* Ref.get(probe.landed)).toEqual(["gated"]);
      expect(textOf(result)).not.toContain(CUT);
    }).pipe(Effect.provide(served(probe)));
  }).pipe(Effect.provide(layerAuth)),
);

it.effect("a thread credential's call is not cut when an unrelated client session is revoked", () =>
  Effect.gen(function* () {
    const probe = yield* makeProbe;
    const client = yield* signIn;
    const thread: McpInvocationContext.McpInvocationScope = {
      environmentId,
      requestNamespace: "provider:thread-session",
      thread: {
        threadId: ThreadId.make("thread"),
        providerSessionId: "thread-session",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(["orchestration"]),
      issuedAt: 0,
    };
    yield* Effect.gen(function* () {
      const running = yield* call(thread, "goat_project_create", create("gated")).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(probe.admitted);
      yield* client.revoke;
      yield* Deferred.succeed(probe.gate, undefined);
      const result = yield* Fiber.join(running);
      expect(yield* Ref.get(probe.landed)).toEqual(["gated"]);
      expect(textOf(result)).not.toContain(CUT);
    }).pipe(Effect.provide(served(probe)));
  }).pipe(Effect.provide(layerAuth)),
);

it.effect("a client that stops waiting still stops a guarded call, which never lands", () =>
  Effect.gen(function* () {
    const probe = yield* makeProbe;
    const client = yield* signIn;
    yield* Effect.gen(function* () {
      const running = yield* call(client.scope, "goat_project_create", create("gated")).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(probe.admitted);
      // What Effect's RPC server does to the handler on a client abort or notifications/cancelled.
      yield* Fiber.interrupt(running);
      expect(yield* Deferred.isDone(probe.stopped)).toBe(true);
      yield* Deferred.succeed(probe.gate, undefined);
      yield* client.revoke;
      expect(yield* Ref.get(probe.landed)).toEqual([]);
    }).pipe(Effect.provide(served(probe)));
  }).pipe(Effect.provide(layerAuth)),
);

const threadId = ThreadId.make("screen-thread");

it.effect.each(["notifications/cancelled", "a client abort"] as const)(
  "%s over /mcp still stops a guarded call, which never lands",
  (stop) =>
    Effect.gen(function* () {
      const probe = yield* makeProbe;
      const client = yield* signIn;
      const http = yield* serveOverHttp({ outside: client.scope }, projectRegistrations(probe));
      yield* http.listTools("outside");
      const requestId = http.nextRequestId();
      const running = yield* http
        .callTool("outside", "goat_project_create", create("gated"))
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(probe.admitted);
      if (stop === "notifications/cancelled")
        yield* http.notify("outside", "notifications/cancelled", { requestId });
      else yield* Fiber.interrupt(running);
      yield* Deferred.await(probe.stopped);
      yield* Fiber.interrupt(running);
      yield* Deferred.succeed(probe.gate, undefined);
      expect(yield* Ref.get(probe.landed)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layerTestLoopback, layerAuth))),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const runId = RunId.make("screen-run");
const turnId = RunAttemptId.make("screen-attempt");
const shell = liveThreadShell(threadId, { activeRunId: runId });
const now = DateTime.makeUnsafe("2026-11-17T00:00:00.000Z");
const run: OrchestrationV2Run = {
  id: runId,
  threadId,
  ordinal: 1,
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "test" },
  providerThreadId: null,
  userMessageId: MessageId.make("screen-message"),
  rootNodeId: null,
  activeAttemptId: turnId,
  status: "running",
  requestedAt: now,
  startedAt: now,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
};
const screenResult: ScreenRunResult = {
  runId,
  turnId,
  cellId: "cell-one",
  status: "completed",
  console: [],
  journal: [],
  truncated: [],
  availability: [],
  imageMetadata: [],
  images: [],
};

it.effect("an image tool registration (goat_screen_run) is guarded like every toolkit tool", () =>
  Effect.gen(function* () {
    const probe = yield* makeProbe;
    const client = yield* signIn;
    // Screen runs come from threads; this scope borrows a client's session end to prove the wrapper.
    const cutBy = client.scope.sessionEnd;
    const scope: McpInvocationContext.McpInvocationScope = {
      environmentId,
      requestNamespace: "screen-test",
      thread: { threadId, providerInstanceId, providerSessionId: "screen-session" },
      client: undefined,
      capabilities: new Set(["preview"]),
      issuedAt: 0,
      ...(cutBy === undefined ? {} : { sessionEnd: cutBy }),
    };
    const screen = McpHttpServer.catalogRegistrations.screen.pipe(
      Layer.provide(layerPermissionProfilesOff),
      Layer.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(shell),
          getThreadRecords: (() =>
            Effect.succeed({
              thread: idleThreadProjection(shell).thread,
              runs: [run],
            })) as ThreadManagement.ThreadManagementService["Service"]["getThreadRecords"],
        }),
      ),
      Layer.provide(
        Layer.mock(ScreenRunService.ScreenRunService)({
          runCell: () => gated(probe, "gated-screen", screenResult),
        }),
      ),
      Layer.provideMerge(McpServer.McpServer.layer),
    );
    yield* Effect.gen(function* () {
      const running = yield* call(scope, "goat_screen_run", { code: "return 1" }).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(probe.admitted);
      yield* client.revoke;
      yield* Deferred.succeed(probe.gate, undefined);
      const result = yield* Fiber.join(running);
      expect(yield* Ref.get(probe.landed)).toEqual([]);
      expect(textOf(result)).toContain(CUT);
    }).pipe(Effect.provide(screen));
  }).pipe(Effect.provide(layerAuth)),
);

const catalogServer = catalog.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(
    Layer.mergeAll(
      dependencies,
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      }),
    ),
  ),
);

it.effect(
  "every tool /mcp registers is guarded, and a tool registered outside the wrapper fails this check",
  () =>
    Effect.gen(function* () {
      const client = yield* signIn;
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        // A session that has already ended: a guarded tool answers the cut without its handler.
        const scope: McpInvocationContext.McpInvocationScope = {
          ...client.scope,
          sessionEnd: { run: () => Effect.succeedNone, release: Effect.void },
        };
        const unguarded = (names: ReadonlyArray<string>) =>
          Effect.filter(names, (name) =>
            call(scope, name, {}).pipe(
              Effect.map((result) => !textOf(result).includes(CUT)),
              Effect.catchCause(() => Effect.succeed(true)),
            ),
          );
        const names = server.tools.map(({ tool }) => tool.name);
        expect(names.length).toBeGreaterThan(100);
        expect(yield* unguarded(names)).toEqual([]);
        // oxlint-disable-next-line goat/no-raw-mcp-registration -- deliberately outside the wrapper, to show the check catches it
        yield* server.addTool({
          tool: new McpSchema.Tool({
            name: "goat_unguarded_probe",
            inputSchema: { type: "object" },
          }),
          annotations: Context.empty(),
          handle: () => Effect.succeed(new McpSchema.CallToolResult({ content: [] })),
        });
        expect(yield* unguarded(["goat_unguarded_probe"])).toEqual(["goat_unguarded_probe"]);
      }).pipe(Effect.provide(catalogServer));
    }).pipe(Effect.provide(layerAuth)),
);

it.effect(
  "an MCP request interrupted while it is being admitted leaves no admission once it ends",
  () =>
    Effect.gen(function* () {
      const reached = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      // markUsed runs after the admission is recorded and before the request finishes admitting.
      const gated = Layer.effect(
        SessionStore.SessionStore,
        Effect.map(SessionStore.make, (store) =>
          SessionStore.SessionStore.of({
            ...store,
            markUsed: () =>
              Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(gate))),
          }),
        ),
      ).pipe(Layer.provideMerge(AuthSessions.layer), Layer.provideMerge(Sqlite.layerMemory));
      yield* Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const store = yield* SessionStore.SessionStore;
        const issued = yield* store.issue({
          subject: "mcp-client",
          method: "bearer-access-token",
          scopes: mcpClientScopes("full-access"),
        });
        const request = yield* Scope.make();
        const admitting = yield* authenticate(auth, issued.token).pipe(
          Effect.provideService(Scope.Scope, request),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(reached);
        yield* Fiber.interrupt(admitting);
        yield* Scope.close(request, Exit.void);
        expect(yield* store.admissionsInFlight()).toBe(0);
      }).pipe(Effect.provide(layerAuthOver(gated)));
    }).pipe(Effect.provide(NodeServices.layer)),
);
