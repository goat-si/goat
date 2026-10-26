import * as NodeModule from "node:module";

import { ComputerUseReadiness, type CuaDriverMcpConfiguration } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import type { ToolResult } from "@trycua/cua-driver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { gdbusRunner, makeSecureFocusProbe } from "./linuxHelper/atspiFocus.ts";
import {
  detectLinuxSession,
  linuxSessionFacts,
  readGnomeShellVersion,
} from "./linuxHelper/linuxSession.ts";
import type { CuaDisplayVariable } from "./CuaDisplayCapability.ts";
import { readLinuxReadiness } from "./linuxHelper/readiness.ts";
import { captureRoute } from "./linuxHelper/windowCapture.ts";
import { captureX11Window } from "./linuxHelper/x11WindowCapture.ts";

const UNWATCHED = { privateMode: "unsupported", humanInput: "unsupported" } as const;

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const requireDriver = NodeModule.createRequire(import.meta.url);
export type DriverClientModule = {
  readonly CuaDriver: {
    readonly connect: (socketPath: string) => {
      readonly callTool: (
        name: string,
        args: string,
        options: { signal: AbortSignal },
      ) => Promise<ToolResult>;
      readonly uniffiDestroy: () => void;
    };
  };
};

/** The driver's own client library, from where the server resolves its packages. */
export const loadDriverSdk = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
) {
  for (const lookup of requireDriver.resolve.paths("@trycua/cua-driver") ?? []) {
    const directory = path.join(lookup, "@trycua", "cua-driver");
    if (!(yield* fs.exists(path.join(directory, "package.json")))) continue;
    return Option.some(
      yield* Effect.try(
        () => requireDriver(path.join(directory, "dist", "index.js")) as DriverClientModule,
      ),
    );
  }
  return Option.none<DriverClientModule>();
});

/** One driver tool's structured answer over the daemon socket; undefined when it errs. */
export const callDriverTool = (
  sdk: DriverClientModule,
  socketPath: string,
  name: string,
  args: object,
) =>
  Effect.tryPromise(async (signal) => {
    const client = sdk.CuaDriver.connect(socketPath);
    try {
      const result = await client.callTool(name, encodeJson(args), { signal });
      return result.isError || result.structuredJson === undefined
        ? undefined
        : decodeJson(result.structuredJson);
    } finally {
      client.uniffiDestroy();
    }
  });

export const makeObserver = Effect.fn("LinuxReadiness.makeObserver")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  return Effect.fn("LinuxReadiness.observe")(
    function* (mcp: CuaDriverMcpConfiguration, display: ReadonlyArray<CuaDisplayVariable>) {
      const socketPath = mcp.socketPath;
      if (!socketPath) return undefined;
      const sessionEnvironment = {
        ...environment,
        ...Object.fromEntries(display.map(({ name, value }) => [name, value])),
      };
      // The helper's own judgement of this session: GNOME 50+ on Wayland is refused, never probed.
      const session = detectLinuxSession(
        linuxSessionFacts(sessionEnvironment, () => readGnomeShellVersion(sessionEnvironment)),
      );
      const gdbus = gdbusRunner(
        Object.fromEntries(
          Object.entries(sessionEnvironment).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      );
      const secureFocus = makeSecureFocusProbe(gdbus);
      // The server's driver runs embedded, and its embedding passes no Hyprland instance on
      // (cua-driver-sdk embedded.rs), so here only an X window's own capture counts.
      const capture = captureRoute({
        session,
        driverEnvironment: {},
        captureX11: (windowId, shot) => captureX11Window(sessionEnvironment, windowId, shot),
      });
      const found = yield* loadDriverSdk(fs, path);
      if (Option.isSome(found)) {
        const sdk = found.value;
        const writable = yield* fs.access("/dev/uinput", { writable: true }).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        return yield* Effect.tryPromise(async (signal) => {
          const client = sdk.CuaDriver.connect(socketPath);
          try {
            return await readLinuxReadiness(
              {
                session,
                secureFocus,
                capture,
                uinputWritable: async () => writable,
                call: async (name, args) => {
                  const result = await client.callTool(name, JSON.stringify(args), { signal });
                  return {
                    isError: result.isError,
                    text: result.text,
                    structured:
                      result.structuredJson === undefined
                        ? undefined
                        : decodeJson(result.structuredJson),
                    images: result.images.map((image) => ({
                      mimeType: image.mimeType,
                      data: image.dataBase64,
                    })),
                  };
                },
              },
              15_000,
            );
          } finally {
            client.uniffiDestroy();
          }
        }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ComputerUseReadiness)),
          // This reads the driver directly, and nothing here watches for a person or a password
          // field, so neither signal is raised until the server runs the helper itself (#1223).
          Effect.map((readiness) => ({ readiness, signals: UNWATCHED })),
        );
      }
      return undefined;
    },
    Effect.orElseSucceed(() => undefined),
  );
});
