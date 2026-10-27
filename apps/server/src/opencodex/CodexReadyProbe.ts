import { type CodexSettings, type ProviderInstanceId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import { resolveAuthlessManagedRuntime } from "../provider/CodexManagedRuntime.ts";
import { withCodexAppServerClient } from "../provider/CodexProvider.ts";
import * as HomeRoute from "../provider/OpenCodexRoute.ts";

export class CodexReadyProbeError extends Schema.TaggedError<CodexReadyProbeError>()(
  "CodexReadyProbeError",
  {
    code: Schema.Literals([
      "route_unverified",
      "probe_unsupported",
      "probe_failed",
      "probe_timeout",
    ]),
  },
) {}

export interface CodexReadyProbeInput {
  readonly instanceId: ProviderInstanceId;
  /** The hydrated instance's own settings; never a draft. */
  readonly settings: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
}
export interface CodexReadyProbeResult {
  readonly model: string;
  readonly executablePath: string;
  readonly executableVersion: string;
}

// Codex features that offer tools; each is switched off for the check. Unrecognized keys are
// rejected by native config verification rather than ignored.
const DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "apps",
  "plugins",
  "browser_use",
  "computer_use",
  "view_image",
  "hooks",
  "multi_agent",
  "multi_agent_v2",
];
// Codex names MCP servers with these characters only, so each can be named in an override.
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const probeLaunchArgs = (servers: ReadonlyArray<string>) =>
  [
    ...DISABLED_FEATURES.map((name) => `features.${name}=false`),
    'web_search="disabled"',
    ...servers.map((name) => `mcp_servers.${name}.enabled=false`),
  ]
    .map((value) => `-c ${JSON.stringify(value)}`)
    .join(" ");
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** The MCP servers the effective config names, or undefined when one cannot be overridden. */
export const configuredMcpServers = (config: Readonly<Record<string, unknown>>) => {
  const servers = config.mcp_servers;
  if (servers === undefined || servers === null) return [];
  if (!isRecord(servers)) return undefined;
  const names = Object.keys(servers);
  return names.every((name) => MCP_SERVER_NAME.test(name)) ? names : undefined;
};
/** Whether the effective config offers the model no tool: every server, feature and search off. */
export const offersNoTools = (config: Readonly<Record<string, unknown>>) => {
  const servers = config.mcp_servers;
  const features = config.features;
  return (
    (servers === undefined ||
      servers === null ||
      (isRecord(servers) &&
        Object.values(servers).every((server) => isRecord(server) && server.enabled === false))) &&
    isRecord(features) &&
    DISABLED_FEATURES.every((name) => features[name] === false) &&
    config.web_search === "disabled"
  );
};
const ALLOWED_ITEMS: ReadonlySet<string> = new Set(["userMessage", "agentMessage", "reasoning"]);
const PROMPT = "Reply exactly READY.";

const fail = (code: CodexReadyProbeError["code"]) => new CodexReadyProbeError({ code });

/**
 * Proves the bootstrap Codex instance completes one real request through its verified Home
 * route: an ephemeral app-server thread in an empty directory, a fixed tiny prompt, the lowest
 * effort the model offers and no tools. Any tool request or item ends the check unproven.
 */
export class CodexReadyProbe extends Context.Service<
  CodexReadyProbe,
  {
    readonly probe: (
      input: CodexReadyProbeInput,
    ) => Effect.Effect<CodexReadyProbeResult, CodexReadyProbeError>;
  }
>()("goat/opencodex/CodexReadyProbe") {}

const make = Effect.gen(function* () {
  const context = yield* Effect.context<
    | CodexInstallation.CodexInstallation
    | ServerConfig.ServerConfig
    | FileSystem.FileSystem
    | Path.Path
    | ChildProcessSpawner.ChildProcessSpawner
    | HomeRoute.OpenCodexRoute
  >();
  const probe = Effect.fn("CodexReadyProbe.probe")(function* (input: CodexReadyProbeInput) {
    const fs = yield* FileSystem.FileSystem;
    const installation = yield* CodexInstallation.CodexInstallation;
    const runtime = yield* resolveAuthlessManagedRuntime({
      settings: input.settings,
      instanceId: input.instanceId,
      environment: input.environment,
    }).pipe(Effect.mapError(() => fail("route_unverified")));
    const executable = yield* installation
      .resolve({ managedOnly: true })
      .pipe(Effect.mapError(() => fail("route_unverified")));
    if (executable.executablePath !== runtime.binaryPath) return yield* fail("route_unverified");
    const cwd = yield* fs
      .makeTempDirectoryScoped({ prefix: "goat-ready-probe-" })
      .pipe(Effect.mapError(() => fail("probe_failed")));
    const route = yield* HomeRoute.resolveCodexRouteContext({
      settings: runtime.config,
      binaryPath: runtime.binaryPath,
      home: runtime.home,
      environment: runtime.environment,
      cwd,
      configArgv: [],
    }).pipe(Effect.mapError(() => fail("route_unverified")));
    // Route verification (effective provider, URL, auth flag, catalog) runs before any request.
    const launch = (servers: ReadonlyArray<string>) =>
      withCodexAppServerClient({
        binaryPath: runtime.binaryPath,
        homePath: runtime.home,
        launchArgs: probeLaunchArgs(servers),
        route,
        cwd,
        environment: route.execution.environment,
      }).pipe(Effect.mapError(() => fail("route_unverified")));
    const effectiveConfig = (client: CodexClient.CodexAppServerClient["Service"]) =>
      client.request("config/read", { cwd, includeLayers: false }).pipe(
        Effect.map((read) => read.config),
        Effect.mapError(() => fail("probe_unsupported")),
      );
    // MCP servers start with a thread, so a first app-server that starts none only names them;
    // the second launches with each one disabled and must show no tool before thread/start.
    const servers = yield* launch([]).pipe(
      Effect.flatMap(({ client }) => effectiveConfig(client)),
      Effect.map(configuredMcpServers),
      Effect.scoped,
    );
    if (servers === undefined) return yield* fail("probe_unsupported");
    const { client } = yield* launch(servers);
    if (!offersNoTools(yield* effectiveConfig(client))) return yield* fail("probe_unsupported");
    const completed = yield* Queue.bounded<CodexSchema.V2TurnCompletedNotification>(16);
    const refused = yield* Queue.bounded<void>(1);
    yield* client.handleServerNotification("turn/completed", (event) =>
      Queue.offer(completed, event).pipe(Effect.asVoid),
    );
    yield* client.handleServerNotification("item/started", (event) =>
      ALLOWED_ITEMS.has(event.item.type)
        ? Effect.void
        : Queue.offer(refused, undefined).pipe(Effect.asVoid),
    );
    // Any server request, known or not, is a tool or approval the check never grants.
    const refuse = Queue.offer(refused, undefined).pipe(
      Effect.andThen(
        Effect.fail(
          new CodexErrors.CodexAppServerSpawnError({
            command: "Ready probe refuses tools",
            cause: "unsupported server request",
          }),
        ),
      ),
    );
    yield* Effect.forEach(
      Object.keys(CodexRpc.SERVER_REQUEST_METHODS) as Array<CodexRpc.ServerRequestMethod>,
      (method) => client.handleServerRequest(method, () => refuse),
      { discard: true },
    );
    yield* client.handleUnknownServerRequest(() => refuse);
    const listed = yield* client
      .request("model/list", { includeHidden: false })
      .pipe(Effect.mapError(() => fail("probe_unsupported")));
    // The Home's configured default, as its catalog serves it; never the first entry.
    const selected = listed.data.find((model) => model.isDefault);
    if (selected === undefined) return yield* fail("probe_unsupported");
    const effort = selected.supportedReasoningEfforts[0]?.reasoningEffort;
    const started = yield* client
      .request("thread/start", {
        ephemeral: true,
        cwd,
        model: selected.model,
        modelProvider: "opencodex",
        approvalPolicy: "never",
        sandbox: "read-only",
        baseInstructions: `${PROMPT} Do not use tools.`,
        developerInstructions: `This is a connection check. ${PROMPT}`,
      })
      .pipe(Effect.mapError(() => fail("probe_unsupported")));
    if (
      started.thread.ephemeral !== true ||
      started.modelProvider !== "opencodex" ||
      started.model !== selected.model
    )
      return yield* fail("route_unverified");
    const turn = yield* client
      .request("turn/start", {
        threadId: started.thread.id,
        input: [{ type: "text", text: PROMPT, text_elements: [] }],
        approvalPolicy: "never",
        model: selected.model,
        ...(effort === undefined ? {} : { effort }),
      })
      .pipe(Effect.mapError(() => fail("probe_failed")));
    // A completion may arrive before turn/start answers; only the matching ids count.
    const finished = Queue.take(completed).pipe(
      Effect.repeat({
        until: (value) => value.threadId === started.thread.id && value.turn.id === turn.turn.id,
      }),
    );
    const event = yield* Effect.raceFirst(
      finished,
      Queue.take(refused).pipe(Effect.andThen(Effect.fail(fail("probe_unsupported")))),
    ).pipe(
      Effect.raceFirst(client.terminated.pipe(Effect.andThen(Effect.fail(fail("probe_failed"))))),
    );
    const output = event.turn.items
      .flatMap((item) => (item.type === "agentMessage" ? [item.text] : []))
      .join("")
      .trim();
    if (
      event.turn.status !== "completed" ||
      event.turn.error ||
      event.turn.items.some((item) => !ALLOWED_ITEMS.has(item.type)) ||
      output !== "READY"
    )
      return yield* fail("probe_failed");
    return {
      model: selected.model,
      executablePath: executable.executablePath,
      executableVersion: executable.version,
    } satisfies CodexReadyProbeResult;
  });
  // The scope closes only this spawned app-server, on success, failure or the deadline.
  const bounded = Effect.fn("CodexReadyProbe.bounded")(function* (input: CodexReadyProbeInput) {
    return yield* probe(input).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: "60 seconds",
        orElse: () => Effect.fail(fail("probe_timeout")),
      }),
      Effect.provide(context),
    );
  });
  return CodexReadyProbe.of({ probe: bounded });
});

export const layer = Layer.effect(CodexReadyProbe, make);
