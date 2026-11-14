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

// Proxies without HTTP/2 need this Cursor CLI setting, which the SDK never reads itself.
const readCursorCliUseHttp1ForAgent = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { CURSOR_CONFIG_DIR, XDG_CONFIG_HOME } = yield* HostProcess.Environment;
  const configDirectory = CURSOR_CONFIG_DIR?.trim()
    ? CURSOR_CONFIG_DIR
    : XDG_CONFIG_HOME?.trim()
      ? path.join(XDG_CONFIG_HOME, "cursor")
      : path.join(yield* HostProcess.HomeDirectory, ".cursor");
  const configPath = path.join(configDirectory, "cli-config.json");
  const config = yield* fileSystem.readFileString(configPath).pipe(
    Effect.flatMap(decodeCursorCliConfig),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined),
    Effect.catch(() =>
      Effect.logWarning("Cursor CLI config could not be read; using the default agent transport", {
        path: configPath,
      }).pipe(Effect.as(undefined)),
    ),
  );
  return config?.network?.useHttp1ForAgent === true;
}).pipe(Effect.withSpan("CursorSdk.readCliUseHttp1ForAgent"));

/** Keeps the shell spawn guard armed while in-process agents run. */

export class CursorSdk extends Context.Service<
  CursorSdk,
  {
    readonly load: typeof loadCursorSdk;
    readonly loadSqlite: typeof loadCursorSqlite;
  }
>()("@goat/provider-cursor/server/CursorSdk") {}

export const layer = Layer.effect(
  CursorSdk,

  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() => containRejections(classifyCursorRejection)),
      (release) => Effect.sync(release),
    );
    // The SDK picks the agent transport per process, so no provider instance can own this.
    const useHttp1ForAgent = yield* readCursorCliUseHttp1ForAgent;
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
    });
  }),
);
