import * as NodeModule from "node:module";

import { ComputerUseReadiness, type CuaDriverMcpConfiguration } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import type { ToolResult } from "@trycua/cua-driver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { gdbusRunner, makeSecureFocusProbe } from "./linuxHelper/atspiFocus.ts";
import { detectLinuxSession } from "./linuxHelper/linuxSession.ts";
import { readLinuxReadiness } from "./linuxHelper/readiness.ts";

const requireDriver = NodeModule.createRequire(import.meta.url);
type ClientModule = {
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

export const makeObserver = Effect.fn("LinuxReadiness.makeObserver")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const session = detectLinuxSession({
    display: environment.DISPLAY,
    waylandDisplay: environment.WAYLAND_DISPLAY,
    sessionBus: environment.DBUS_SESSION_BUS_ADDRESS,
    currentDesktop: environment.XDG_CURRENT_DESKTOP,
    gnomeShellMajor: null,
  });
  const secureFocus = makeSecureFocusProbe(
    gdbusRunner(
      Object.fromEntries(
        Object.entries(environment).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    ),
  );
  return Effect.fn("LinuxReadiness.observe")(
    function* (mcp: CuaDriverMcpConfiguration) {
      const socketPath = mcp.socketPath;
      if (!socketPath) return undefined;
      for (const lookup of requireDriver.resolve.paths("@trycua/cua-driver") ?? []) {
        const directory = path.join(lookup, "@trycua", "cua-driver");
        if (!(yield* fs.exists(path.join(directory, "package.json")))) continue;
        const sdk = yield* Effect.try(
          () => requireDriver(path.join(directory, "dist", "index.js")) as ClientModule,
        );
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
                uinputWritable: async () => writable,
                call: async (name, args) => {
                  const result = await client.callTool(name, JSON.stringify(args), { signal });
                  return {
                    isError: result.isError,
                    text: result.text,
                    structured:
                      result.structuredJson === undefined
                        ? undefined
                        : Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
                            result.structuredJson,
                          ),
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
        }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ComputerUseReadiness)));
      }
      return undefined;
    },
    Effect.orElseSucceed(() => undefined),
  );
});
