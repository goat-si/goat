// @effect-diagnostics-next-line nodeBuiltinImport:off -- the bundle's compile cache sits beside it.
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import type {
  AcpAdapterV2Flavor,
  AcpAdapterV2RuntimeInput,
} from "@goat/provider-acp/server/adapter";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import { afterAll } from "vite-plus/test";

export const decodeUnknownJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

// Node spends about half a second loading the mock agent's TypeScript module graph on every
// spawn; a bundle built once per test file starts faster. Tests still talk to a real subprocess.
const bundleScope = Scope.makeUnsafe();
afterAll(() => Effect.runPromise(Scope.close(bundleScope, Exit.void)));
const bundleMockAgent = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-acp-agents-" });
  const mock = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
  );
  const { build } = yield* Effect.promise(() => import("vite-plus"));
  yield* Effect.promise(() =>
    build({
      configFile: false,
      logLevel: "silent",
      root: path.dirname(mock),
      ssr: { noExternal: true },
      build: {
        ssr: true,
        outDir,
        rollupOptions: { input: { mock }, output: { format: "es", entryFileNames: "[name].mjs" } },
      },
    }),
  );
  return path.join(outDir, "mock.mjs");
}).pipe(Scope.provide(bundleScope), Effect.provide(NodeServices.layer));
let bundledMockAgent: Promise<string> | undefined;
export const bundledMockAgentPath = Effect.promise(
  () => (bundledMockAgent ??= Effect.runPromise(bundleMockAgent)),
);

export function makeMockRuntime(input: {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly mockAgentPath: string;
  readonly environment?:
    | Readonly<Record<string, string>>
    | ((runtimeOrdinal: number) => Readonly<Record<string, string>>);
  readonly protocolEvents?: Queue.Queue<EffectAcpProtocol.AcpProtocolLogEvent>;
  readonly cancelBehavior?: AcpSessionRuntime.AcpSessionRuntimeOptions["cancelBehavior"];
  readonly ownDescendantProcessGroups?: boolean;
  readonly ownDetachedProcessGroup?: boolean;
  readonly processGroupPlatform?: NodeJS.Platform;
  readonly processGroupTerminationGrace?: Duration.Input;
  readonly linuxCgroupController?: AcpSessionRuntime.AcpSessionRuntimeOptions["linuxCgroupController"];
  readonly posixProcessTreeController?: AcpSessionRuntime.AcpSessionRuntimeOptions["posixProcessTreeController"];
  readonly windowsProcessTreeTerminator?: AcpSessionRuntime.AcpSessionRuntimeOptions["windowsProcessTreeTerminator"];
  readonly wrapCancel?: (
    cancel: AcpSessionRuntime.AcpSessionRuntime["Service"]["cancel"],
  ) => AcpSessionRuntime.AcpSessionRuntime["Service"]["cancel"];
  readonly wrapOutgoingResponse?: (
    onOutgoingResponse: NonNullable<AcpAdapterV2RuntimeInput["onOutgoingResponse"]>,
  ) => NonNullable<AcpAdapterV2RuntimeInput["onOutgoingResponse"]>;
  readonly wrapRuntime?: (
    runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
    runtimeOrdinal: number,
  ) => AcpSessionRuntime.AcpSessionRuntime["Service"];
}): AcpAdapterV2Flavor["makeRuntime"] {
  let runtimeOrdinal = 0;
  return (runtimeInput) =>
    Effect.gen(function* () {
      runtimeOrdinal += 1;
      const protocolEvents = input.protocolEvents;
      const protocolLogging =
        protocolEvents === undefined
          ? runtimeInput.protocolLogging
          : {
              ...runtimeInput.protocolLogging,
              logIncoming: true,
              logOutgoing: true,
              logger: (event: EffectAcpProtocol.AcpProtocolLogEvent) =>
                Queue.offer(protocolEvents, event).pipe(
                  Effect.andThen(runtimeInput.protocolLogging.logger?.(event) ?? Effect.void),
                  Effect.asVoid,
                ),
            };
      const context = yield* Layer.build(
        AcpSessionRuntime.layer({
          ...runtimeInput,
          ...(input.cancelBehavior === undefined ? {} : { cancelBehavior: input.cancelBehavior }),
          ...(input.ownDetachedProcessGroup === undefined
            ? {}
            : { ownDetachedProcessGroup: input.ownDetachedProcessGroup }),
          ...(input.ownDescendantProcessGroups === undefined
            ? {}
            : { ownDescendantProcessGroups: input.ownDescendantProcessGroups }),
          ...(input.ownDetachedProcessGroup === true
            ? { processGroupPlatform: input.processGroupPlatform ?? "linux" }
            : {}),
          ...(input.processGroupTerminationGrace === undefined
            ? {}
            : { processGroupTerminationGrace: input.processGroupTerminationGrace }),
          ...(input.linuxCgroupController === undefined
            ? {}
            : { linuxCgroupController: input.linuxCgroupController }),
          ...(input.posixProcessTreeController === undefined
            ? {}
            : { posixProcessTreeController: input.posixProcessTreeController }),
          ...(input.windowsProcessTreeTerminator === undefined
            ? {}
            : { windowsProcessTreeTerminator: input.windowsProcessTreeTerminator }),
          protocolLogging,
          spawn: {
            command: process.execPath,
            args: [input.mockAgentPath],
            cwd: runtimeInput.cwd,
            env: {
              GOAT_ACP_SESSION_LIFECYCLE: "1",
              ...(input.mockAgentPath.endsWith(".mjs")
                ? {
                    NODE_COMPILE_CACHE: NodePath.join(
                      NodePath.dirname(input.mockAgentPath),
                      "cache",
                    ),
                  }
                : {}),
              ...(typeof input.environment === "function"
                ? input.environment(runtimeOrdinal)
                : input.environment),
            },
          },
          authMethodId: "test",
          ...(input.wrapOutgoingResponse === undefined ||
          runtimeInput.onOutgoingResponse === undefined
            ? {}
            : {
                onOutgoingResponse: input.wrapOutgoingResponse(runtimeInput.onOutgoingResponse),
              }),
        }).pipe(
          Layer.provide(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
          ),
        ),
      );
      const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(context),
      );
      const wrapped = {
        ...runtime,
        ...(input.wrapCancel === undefined ? {} : { cancel: input.wrapCancel(runtime.cancel) }),
      };
      return input.wrapRuntime?.(wrapped, runtimeOrdinal) ?? wrapped;
    });
}

export function rawProtocolMethod(
  event: EffectAcpProtocol.AcpProtocolLogEvent,
): string | undefined {
  if (event.stage !== "raw" || typeof event.payload !== "string") return undefined;
  for (const line of event.payload.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const decoded = Option.getOrUndefined(decodeUnknownJson(trimmed));
    if (typeof decoded === "object" && decoded !== null && "method" in decoded) {
      const method = (decoded as { readonly method?: unknown }).method;
      if (typeof method === "string") return method;
    }
  }
  return undefined;
}

export function rawProtocolRequest(
  event: EffectAcpProtocol.AcpProtocolLogEvent,
): { readonly method?: unknown; readonly params?: unknown } | undefined {
  if (event.stage !== "raw" || typeof event.payload !== "string") return undefined;
  for (const line of event.payload.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const decoded = Option.getOrUndefined(decodeUnknownJson(trimmed));
    if (typeof decoded === "object" && decoded !== null && "method" in decoded) {
      return decoded;
    }
  }
  return undefined;
}

export function rawProtocolRequestParam(
  event: EffectAcpProtocol.AcpProtocolLogEvent,
  key: string,
): unknown {
  const params = rawProtocolRequest(event)?.params;
  return typeof params === "object" && params !== null ? Reflect.get(params, key) : undefined;
}

export function rawProtocolPromptTextBlocks(
  event: EffectAcpProtocol.AcpProtocolLogEvent,
): Array<{ type: "text"; text: string }> {
  const prompt = rawProtocolRequestParam(event, "prompt");
  if (!Array.isArray(prompt)) return [];
  return prompt.flatMap((block) =>
    typeof block === "object" &&
    block !== null &&
    Reflect.get(block, "type") === "text" &&
    typeof Reflect.get(block, "text") === "string"
      ? [{ type: "text" as const, text: Reflect.get(block, "text") as string }]
      : [],
  );
}

export const pollProtocolMethods = (events: Queue.Queue<EffectAcpProtocol.AcpProtocolLogEvent>) =>
  Effect.gen(function* () {
    const methods: string[] = [];
    let polled = 0;
    let event = yield* Queue.poll(events);
    while (Option.isSome(event) && polled < 256) {
      polled += 1;
      const method = rawProtocolMethod(event.value);
      if (method !== undefined) methods.push(method);
      event = yield* Queue.poll(events);
    }
    return methods;
  });
