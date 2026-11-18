import { containRejections } from "@goat/shared/processErrorNet";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { loadCursorSdk, loadCursorSqlite } from "./sdk.ts";

/**
 * After a local exec fails, the SDK writes a final frame to the exec's stream from
 * a promise nothing awaits. If that stream has already closed, the write rejects.
 * The SDK's class is minified, so only its name and message identify it.
 */
const classifyCursorRejection = (reason: unknown) => {
  if (!(reason instanceof Error)) return undefined;
  if (
    reason.name === "WriteIterableClosedError" &&
    reason.message === "WritableIterable is closed"
  ) {
    return "Cursor SDK wrote to a closed exec stream.";
  }
  if (
    reason.name === "ConnectError" &&
    Reflect.get(reason, "code") === 10 &&
    reason.cause instanceof Error &&
    Reflect.get(reason.cause, "code") === "ERR_STREAM_WRITE_AFTER_END"
  ) {
    return "Cursor SDK wrote to an ended request stream.";
  }
  return undefined;
};

const decodeCursorCliConfig = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      network: Schema.optionalKey(
        Schema.Struct({ useHttp1ForAgent: Schema.optionalKey(Schema.Boolean) }),
      ),
    }),
  ),
);

/** Shown when a new session's Cursor configuration selects another transport than GOAT loaded. */
export const CURSOR_AGENT_TRANSPORT_RESTART_MESSAGE =
  "Cursor's agent transport setting (network.useHttp1ForAgent in cli-config.json) differs from the one GOAT read from the server's Cursor configuration at startup. All Cursor agents share one transport: make this instance's Cursor configuration agree with the server's, or change the server's and restart GOAT.";

/** Shown when the Cursor configuration a session names cannot be read to choose a transport. */
const unreadableTransportMessage = (path: string) =>
  `GOAT could not read Cursor's configuration at ${path} to choose the agent transport (network.useHttp1ForAgent). Fix or remove that file, then try again.`;

/** The agent transport a Cursor configuration selects; a missing file selects the default. */
type CursorCliTransport =
  | { readonly http1: boolean; readonly unreadable?: undefined }
  | { readonly unreadable: string };

// Proxies without HTTP/2 need this Cursor CLI setting, which the SDK never reads itself.
const readCursorCliTransport = Effect.fnUntraced(function* (
  environment: NodeJS.ProcessEnv,
  serverHome: string,
  platform: NodeJS.Platform,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { CURSOR_CONFIG_DIR, XDG_CONFIG_HOME } = environment;
  const home =
    (platform === "win32" ? environment.USERPROFILE : environment.HOME)?.trim() || serverHome;
  const configDirectory = CURSOR_CONFIG_DIR?.trim()
    ? CURSOR_CONFIG_DIR
    : XDG_CONFIG_HOME?.trim()
      ? path.join(XDG_CONFIG_HOME, "cursor")
      : path.join(home, ".cursor");
  const configPath = path.join(configDirectory, "cli-config.json");
  const transport: CursorCliTransport = yield* fileSystem.readFileString(configPath).pipe(
    Effect.flatMap(decodeCursorCliConfig),
    Effect.map((config) => ({ http1: config.network?.useHttp1ForAgent === true })),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed({ http1: false })),
    Effect.orElseSucceed(() => ({ unreadable: configPath })),
  );
  return transport;
}, Effect.withSpan("CursorSdk.readCliTransport"));

/** Keeps the shell spawn guard armed while in-process agents run. */
export class CursorSdk extends Context.Service<
  CursorSdk,
  {
    readonly load: typeof loadCursorSdk;
    readonly loadSqlite: typeof loadCursorSqlite;
    /** Why a session in this environment cannot use this process's transport, if it cannot. */
    readonly agentTransportRefusal?: (
      environment: NodeJS.ProcessEnv,
    ) => Effect.Effect<string | undefined>;
  }
>()("@goat/provider-cursor/server/CursorSdk") {}

export const layer = Layer.effect(
  CursorSdk,
  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() => containRejections(classifyCursorRejection)),
      (release) => Effect.sync(release),
    );
    // The SDK picks the agent transport per process, so no provider instance can own this; a new
    // session whose configuration selects another one is refused with a restart message.
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const platform = yield* HostProcess.Platform;
    const readTransport = (environment: NodeJS.ProcessEnv) =>
      readCursorCliTransport(environment, home, platform).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
    // The process must pick a transport, so an unreadable configuration here means the default.
    const startup = yield* readTransport(yield* HostProcess.Environment);
    if (startup.unreadable !== undefined) {
      yield* Effect.logWarning(
        "Cursor CLI config could not be read; using the default agent transport",
        {
          path: startup.unreadable,
        },
      );
    }
    const useHttp1ForAgent = startup.unreadable === undefined && startup.http1;
    let configured = false;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (configured) loadCursorSdk().Cursor.configure({ local: { useHttp1ForAgent: null } });
      }),
    );
    return CursorSdk.of({
      load: () => {
        const sdk = loadCursorSdk();
        if (useHttp1ForAgent && !configured) {
          sdk.Cursor.configure({ local: { useHttp1ForAgent: true } });
          configured = true;
        }
        return sdk;
      },
      loadSqlite: loadCursorSqlite,
      agentTransportRefusal: Effect.fn("CursorSdk.agentTransportRefusal")(function* (
        environment: NodeJS.ProcessEnv,
      ) {
        const transport = yield* readTransport(environment);
        if (transport.unreadable !== undefined)
          return unreadableTransportMessage(transport.unreadable);
        return transport.http1 === useHttp1ForAgent
          ? undefined
          : CURSOR_AGENT_TRANSPORT_RESTART_MESSAGE;
      }),
    });
  }),
);
