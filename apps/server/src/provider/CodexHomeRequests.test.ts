import * as HostProcess from "@goat/shared/HostProcess";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  CodexSettings,
  EnvironmentAuthorizationError,
  MessageId,
  NodeId,
  RunId,
  handoffSummary,
  Handoff,
  ProviderDriverKind,
  ProviderHomeRouteConfig,
  ThreadId,
  TurnItemId,
  type ProviderHomeRequestAction,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Settings from "../serverSettings.ts";
import * as Config from "../config.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Inventory from "../opencodex/OpenCodexInventory.ts";
import * as Runner from "../processRunner.ts";
import * as Installation from "./CodexInstallation.ts";
import * as HomeRequests from "./ProviderHomeRequests.ts";
import * as HomeRoute from "./OpenCodexRoute.ts";
import * as Routes from "./CodexRouteService.ts";
import {
  caller,
  commitAndApply,
  environmentId,
  instanceId,
  layer,
  sessionId,
} from "./CodexRouteService.testkit.ts";
const decode = Schema.decodeUnknownSync(CodexSettings);
const decodeRoute = Schema.decodeUnknownSync(ProviderHomeRouteConfig);
const approval = (
  action: ProviderHomeRequestAction,
  driver = "codex",
  options: {
    readonly config?: Readonly<Record<string, unknown>>;
    readonly installation?: {
      readonly managedDirectory: string;
      readonly acquire: Installation.CodexInstallation["Service"]["acquire"];
    };
    readonly homeRoute?: HomeRoute.OpenCodexRoute["Service"];
  } = {},
) =>
  Effect.gen(function* () {
    const routes = yield* Routes.CodexRouteService;
    const settings = yield* Settings.ServerSettingsService;
    yield* settings.start;
    const route = {
      modelRoute: action === "disconnect" ? "opencodex" : "default",
      ...options.config,
    };
    const config = driver === "codex" ? decode(route) : route;
    const instance = {
      driver: ProviderDriverKind.make(driver),
      displayName: "Approved A",
      config,
    };
    yield* commitAndApply(
      routes.mutateProviderInstance(
        { mutation: { operation: "create", instanceId, instance } },
        caller,
      ),
    );
    const captured = yield* routes.capture(instanceId);
    const now = yield* DateTime.now;
    const handoff: Handoff = {
      handoffId: TurnItemId.make("provider-home-approval-a"),
      kind: "approval",
      title: "Review Home",
      reason: "Route review",
      requestedBy: {
        threadId: ThreadId.make("owner-thread"),
        providerInstanceId: instanceId,
        path: "provider.home_request",
      },
      target: { environmentId, path: "provider.home_request" },
      dedupeKey: "test-a",
      state: "completed",
      createdAt: now,
      expiresAt: DateTime.add(now, { minutes: 15 }),
      actor: { type: "client", label: "Reviewer" },
    };
    const args = {
      version: 1,
      request: { instanceId, action },
      instance,
      expectedFingerprint: captured.fingerprint,
      expectedRevision: captured.revision,
      environmentId,
    };
    const read = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let finished = 0;
    const created: Array<Parameters<Handoffs.Handoffs["Service"]["create"]>[0]> = [];
    const threadId = handoff.requestedBy.threadId;
    const projection = {
      ...idleThreadProjection(liveThreadShell(threadId)),
      runs: [
        {
          id: RunId.make("request-run"),
          threadId,
          ordinal: 1,
          providerInstanceId: instanceId,
          modelSelection: { instanceId, model: "test" },
          providerThreadId: null,
          userMessageId: MessageId.make("request-message"),
          rootNodeId: NodeId.make("request-node"),
          activeAttemptId: null,
          status: "running" as const,
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
          memoryGrantCeiling: "none" as const,
        },
      ],
    };
    const dependencies = Layer.mergeAll(
      Layer.mock(Inventory.OpenCodexInventory)({}),
      Layer.mock(Runner.ProcessRunner)({}),
      Layer.mock(Installation.CodexInstallation)(
        options.installation ?? { managedDirectory: "unused-approval-installation" },
      ),
      Layer.succeed(Environment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
      Layer.mock(Threads.ThreadManagementService)({
        getThreadSnapshot: () =>
          Effect.succeed({ schemaVersion: 1, snapshotSequence: 0, projection }),
      }),
      Layer.mock(Handoffs.Handoffs)({
        create: (input) =>
          Effect.sync(() => {
            created.push(input);
            return handoffSummary({
              ...handoff,
              kind: input.kind,
              title: input.title,
              state: "pending",
              expiresAt: input.expiresAt ?? null,
            });
          }),
        completedProviderHomeContinuations: Effect.succeed([
          { handoff, args, approvedBySessionId: sessionId },
        ]),
        open: () => Effect.succeed({ handoff, human: null }),
        finishProviderHomeContinuation: () =>
          Effect.sync(() => {
            finished++;
          }),
      }),
      Layer.succeed(
        HomeRoute.OpenCodexRoute,
        options.homeRoute ?? {
          inspect: () => Effect.die("Not used by approval executor"),
          launchArgs: () => Effect.die("Not used by approval executor"),
          requireAvailable: () =>
            Deferred.succeed(read, undefined).pipe(Effect.andThen(Deferred.await(resume))),
        },
      ),
    );
    const requests = Context.get(
      yield* Layer.build(HomeRequests.layerWithoutInventory.pipe(Layer.provide(dependencies))),
      HomeRequests.ProviderHomeRequests,
    );
    return { routes, requests, read, resume, instance, created, finished: () => finished };
  });
const liveThread = (requestNamespace: string) => ({
  environmentId,
  readOnly: false,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
  requestNamespace,
  thread: {
    threadId: ThreadId.make("owner-thread"),
    providerInstanceId: instanceId,
    providerSessionId: "source-session",
  },
  client: undefined,
  grantedScopes: ["orchestration:read" as const],
  reauthorize: () => Effect.void,
});
it.effect(
  "preserves a competing UI edit when approval admission resumes after the executor read",
  () =>
    Effect.gen(function* () {
      const f = yield* approval("connect");
      const executor = yield* f.requests.resumeContinuations.pipe(Effect.forkScoped);
      yield* Deferred.await(f.read);
      yield* commitAndApply(
        f.routes.mutateProviderInstance(
          {
            mutation: {
              operation: "upsert",
              instanceId,
              instance: {
                ...f.instance,
                displayName: "Competing UI B",
                config: { ...f.instance.config, launchArgs: "--enable explicit_b" },
              },
            },
          },
          caller,
        ),
      );
      const fs = yield* FileSystem.FileSystem;
      const config = yield* Config.ServerConfig;
      const before = yield* fs.readFileString(config.settingsPath);
      const revision = (yield* f.routes.capture(instanceId)).revision;
      yield* Deferred.succeed(f.resume, undefined);
      yield* Fiber.join(executor);
      const result = yield* f.routes.capture(instanceId);
      assert.equal(result.instance.displayName, "Competing UI B");
      assert.deepStrictEqual(result.revision, revision);
      assert.equal(yield* fs.readFileString(config.settingsPath), before);
      assert.equal(f.finished(), 1);
    }).pipe(Effect.provide(layer)),
);
it.effect(
  "applies the approved default reversal through the same mutation service without probing Home",
  () =>
    Effect.gen(function* () {
      const f = yield* approval("disconnect");
      yield* commitAndApply(f.requests.resumeContinuations);
      const config = decode((yield* f.routes.capture(instanceId)).instance.config);
      assert.equal(config.modelRoute, "default");
      assert.isFalse(yield* Deferred.isDone(f.read));
      assert.equal(f.finished(), 1);
    }).pipe(Effect.provide(layer)),
);
it.effect("rejects an outside-thread request without creating a fake approval", () =>
  Effect.gen(function* () {
    const f = yield* approval("disconnect");
    const result = yield* f.requests.request(
      { instanceId, action: "connect" },
      {
        environmentId,
        readOnly: false,
        capabilities: new Set(["orchestration"]),
        issuedAt: 0,
        requestNamespace: "external-agent",
        thread: undefined,
        client: undefined,
      },
    );
    assert.equal(result.kind, "error");
    if (result.kind === "error") assert.equal(result.code, "unsupported");
    assert.equal(f.finished(), 0);
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["connect", "disconnect"] as const)(
  "explains the exact %s account consequence before creating an approval",
  (action) =>
    Effect.gen(function* () {
      const f = yield* approval(action);
      const before = yield* f.routes.capture(instanceId);
      const seen: Array<ReadonlyArray<string>> = [];
      const result = yield* f.requests
        .request(
          { instanceId, action },
          {
            environmentId,
            readOnly: false,
            capabilities: new Set(["orchestration"]),
            issuedAt: 0,
            requestNamespace: "approval-copy",
            thread: {
              threadId: ThreadId.make("owner-thread"),
              providerInstanceId: instanceId,
              providerSessionId: "source-session",
            },
            client: undefined,
            grantedScopes: ["orchestration:read"],
            reauthorize: (required) => Effect.sync(() => void seen.push(required)),
          },
        )
        .pipe(Effect.provideService(HostProcess.Hostname, "vps-1"));
      assert.equal(result.kind, "needs_human");
      assert.deepStrictEqual(seen, [["orchestration:read"]]);
      assert.equal(f.created.length, 1);
      assert.equal(
        f.created[0]?.reason,
        action === "connect"
          ? "An agent asked to route this Codex instance through OpenCodex Home."
          : "An agent asked to stop routing this Codex instance through OpenCodex Home.",
      );
      assert.equal(
        f.created[0]?.human.location,
        action === "connect"
          ? "Approved A on vps-1 will send model requests through OpenCodex Home and use its accounts and shared quota. If Home is unavailable, it stops instead of switching accounts."
          : "Approved A on vps-1 goes back to Codex's own settings. OpenCodex stays connected to Home; run ocx disconnect on vps-1 to disconnect it.",
      );
      assert.deepStrictEqual(yield* f.routes.capture(instanceId), before);
    }).pipe(Effect.provide(layer)),
);

it.effect("refuses a read-only thread and a thread whose turn is no longer live", () =>
  Effect.gen(function* () {
    const f = yield* approval("connect");
    const thread = {
      environmentId,
      readOnly: false,
      capabilities: new Set(["orchestration" as const]),
      issuedAt: 0,
      requestNamespace: "approval-copy",
      thread: {
        threadId: ThreadId.make("owner-thread"),
        providerInstanceId: instanceId,
        providerSessionId: "source-session",
      },
      client: undefined,
      grantedScopes: ["orchestration:read" as const],
      reauthorize: () => Effect.void,
    };
    const readOnly = yield* f.requests.request(
      { instanceId, action: "connect" },
      { ...thread, readOnly: true },
    );
    assert.equal(readOnly.kind, "error");
    if (readOnly.kind === "error") assert.equal(readOnly.code, "unsupported");
    const dead = yield* f.requests.request(
      { instanceId, action: "connect" },
      {
        ...thread,
        reauthorize: () =>
          Effect.fail(
            new EnvironmentAuthorizationError({
              requiredScope: "orchestration:read",
              message: "The turn is no longer live.",
            }),
          ),
      },
    );
    assert.equal(dead.kind, "error");
    if (dead.kind === "error") assert.equal(dead.code, "capability_denied");
    assert.equal(f.created.length, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["codex", "claudeAgent", "opencode", "pi"])(
  "creates a Home approval for a captured %s instance without changing its configuration",
  (driver) =>
    Effect.gen(function* () {
      const f = yield* approval("connect", driver);
      const fs = yield* FileSystem.FileSystem;
      const server = yield* Config.ServerConfig;
      const before = yield* f.routes.capture(instanceId);
      const bytes = yield* fs.readFileString(server.settingsPath);
      const result = yield* f.requests
        .request({ instanceId, action: "connect" }, liveThread("driver-approval"))
        .pipe(Effect.provideService(HostProcess.Hostname, "test-child"));
      assert.equal(result.kind, "needs_human");
      const label = { codex: "Codex", claudeAgent: "Claude Code", opencode: "OpenCode", pi: "Pi" }[
        driver
      ];
      assert.equal(
        f.created[0]?.reason,
        `An agent asked to route this ${label} instance through OpenCodex Home.`,
      );
      assert.equal(
        f.created[0]?.human.location.includes("existing Pi credentials, settings and extensions"),
        driver === "pi",
      );
      assert.deepStrictEqual(yield* f.routes.capture(instanceId), before);
      assert.equal(yield* fs.readFileString(server.settingsPath), bytes);
    }).pipe(Effect.provide(layer)),
);

it.effect.each(["claudeAgent", "opencode", "pi"])(
  "applies an approved %s disconnect without probing Home or touching its other settings",
  (driver) =>
    Effect.gen(function* () {
      const f = yield* approval("disconnect", driver, {
        config: { opencodexBaseUrl: "http://127.0.0.1:10101/v1" },
      });
      yield* commitAndApply(f.requests.resumeContinuations);
      const after = (yield* f.routes.capture(instanceId)).instance;
      assert.equal(after.driver, driver);
      assert.deepStrictEqual(decodeRoute(after.config), {
        modelRoute: "default",
        opencodexBaseUrl: "http://127.0.0.1:10101/v1",
      });
      assert.isFalse(yield* Deferred.isDone(f.read));
      assert.equal(f.finished(), 1);
    }).pipe(Effect.provide(layer)),
);

it.effect.each([
  { name: "absent auth", config: { setupMode: "managed" }, accepted: false },
  {
    name: "openai auth",
    config: { setupMode: "managed", opencodexAuth: "openai" },
    accepted: false,
  },
  { name: "none auth", config: { setupMode: "managed", opencodexAuth: "none" }, accepted: true },
])("names the managed-instance auth repair before connect: $name", ({ config, accepted }) =>
  Effect.gen(function* () {
    const f = yield* approval("connect", "codex", { config });
    const before = yield* f.routes.capture(instanceId);
    const fs = yield* FileSystem.FileSystem;
    const server = yield* Config.ServerConfig;
    const bytes = yield* fs.readFileString(server.settingsPath);
    const result = yield* f.requests
      .request({ instanceId, action: "connect" }, liveThread("managed-connect-recovery"))
      .pipe(Effect.provideService(HostProcess.Hostname, "test-child"));
    if (accepted) {
      assert.equal(result.kind, "needs_human");
      assert.equal(f.created.length, 1);
    } else {
      assert.deepStrictEqual(result, {
        kind: "error",
        code: "unsupported",
        message:
          "Set opencodexAuth to none for this instance in Settings or with provider.update, then connect again.",
      });
      assert.equal(f.created.length, 0);
    }
    assert.deepStrictEqual(yield* f.routes.capture(instanceId), before);
    assert.equal(yield* fs.readFileString(server.settingsPath), bytes);
    assert.isFalse(yield* Deferred.isDone(f.read));
    assert.equal(f.finished(), 0);
  }).pipe(Effect.provide(layer)),
);

it.live.each([
  { name: "clean", retained: {}, accepted: true },
  {
    name: "profile bearer",
    retained: { experimental_bearer_token: "synthetic-inherited" },
    accepted: false,
  },
  {
    name: "user header",
    retained: { http_headers: { Authorization: "Bearer synthetic" } },
    accepted: false,
  },
])(
  "preflights managed Home with the acquired executable and effective shadow before committing: $name",
  ({ retained, accepted }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "approval-managed-runtime-" });
      const shared = `${directory}/shared`;
      const shadow = `${directory}/shadow`;
      const binary = `${directory}/selected-codex`;
      const catalog = `${shadow}/opencodex-catalog.json`;
      const observed = `${directory}/requests.jsonl`;
      const base = "http://127.0.0.1:10100/v1";
      const effective = {
        model_provider: "opencodex",
        model_catalog_json: catalog,
        model_providers: {
          opencodex: {
            name: "OpenCodex",
            base_url: base,
            wire_api: "responses",
            requires_openai_auth: false,
            ...retained,
          },
        },
      };
      // A scripted app-server peer at the stdio boundary: it answers initialize and config/read
      // with a retained effective configuration and records the home each request ran in.
      const peer = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const config = ${JSON.stringify(effective)};
const observed = ${JSON.stringify(observed)};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  fs.appendFileSync(observed, JSON.stringify({ method, home: process.env.CODEX_HOME }) + "\\n");
  const result = method === "initialize"
    ? { userAgent: "codex/0.156.1", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "linux" }
    : method === "config/read" ? { config, origins: {} } : null;
  process.stdout.write(JSON.stringify({ id, result }) + "\\n");
});`;
      yield* fs.writeFileString(binary, peer);
      yield* fs.chmod(binary, 0o755);
      const executable = {
        executablePath: binary,
        version: "0.156.1",
        source: "managed" as const,
        managedVersionDirectory: directory,
      };
      let leases = 0;
      const f = yield* approval("connect", "codex", {
        config: {
          setupMode: "managed",
          opencodexAuth: "none",
          binaryPath: "",
          homePath: shared,
          shadowHomePath: shadow,
          opencodexBaseUrl: base,
        },
        installation: {
          managedDirectory: directory,
          acquire: (options) =>
            Effect.gen(function* () {
              assert.equal(options?.managedOnly, true);
              leases++;
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  leases--;
                }),
              );
              return executable;
            }),
        },
        homeRoute: {
          inspect: () => Effect.die("Approval does not publish status"),
          requireAvailable: () => Effect.void,
          launchArgs: () => Effect.succeed(["-c", `model_catalog_json=${JSON.stringify(catalog)}`]),
        },
      });
      const before = yield* f.routes.capture(instanceId);
      const server = yield* Config.ServerConfig;
      const bytes = yield* fs.readFileString(server.settingsPath);
      // A refused preflight commits nothing, so only an accepted one has a revision to apply.
      yield* accepted
        ? commitAndApply(f.requests.resumeContinuations)
        : f.requests.resumeContinuations;
      const after = yield* f.routes.capture(instanceId);
      assert.equal(decode(after.instance.config).modelRoute, accepted ? "opencodex" : "default");
      if (!accepted) {
        assert.deepStrictEqual(after, before);
        assert.equal(yield* fs.readFileString(server.settingsPath), bytes);
      }
      const requests = (yield* fs.readFileString(observed))
        .trim()
        .split("\n")
        .map((line): { readonly method: string; readonly home: string } => JSON.parse(line));
      assert.deepEqual(
        requests.map((entry) => entry.method),
        ["initialize", "config/read"],
      );
      assert.isTrue(requests.every((entry) => entry.home === shadow));
      assert.equal(leases, 0);
      assert.equal(f.finished(), 1);
    }).pipe(Effect.provide(layer), Effect.scoped),
);
