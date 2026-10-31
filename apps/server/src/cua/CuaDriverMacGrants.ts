import * as NodeModule from "node:module";
import type { CuaDriverMcpConfiguration } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as CuaDisplay from "./CuaDisplayCapability.ts";

const requireForCuaDriver = NodeModule.createRequire(import.meta.url);

type SdkClientModule = {
  readonly CuaDriver: {
    readonly connect: (socketPath: string) => {
      readonly callTool: (
        name: string,
        argumentsJson: string,
      ) => Promise<{ readonly isError: boolean; readonly structuredJson?: string }>;
      readonly uniffiDestroy?: () => void;
    };
  };
};

/** Asks the running daemon, which is the process macOS grants, for its own permissions. */
export const makeMacGrantObserver = Effect.fn("CuaDriver.makeMacGrantObserver")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return (mcp: CuaDriverMcpConfiguration) =>
    Effect.gen(function* () {
      const socketPath = mcp.socketPath;
      if (!socketPath) return null;
      for (const lookup of requireForCuaDriver.resolve.paths("@trycua/cua-driver") ?? []) {
        const directory = path.join(lookup, "@trycua", "cua-driver");
        if (!(yield* fs.exists(path.join(directory, "package.json")))) continue;
        const sdk: SdkClientModule = yield* Effect.try(() =>
          requireForCuaDriver(path.join(directory, "dist", "index.js")),
        );
        return yield* Effect.tryPromise(async () => {
          const client = sdk.CuaDriver.connect(socketPath);
          try {
            const result = await client.callTool("check_permissions", "{}");
            return result.isError ? null : CuaDisplay.parseMacGrants(result.structuredJson);
          } finally {
            client.uniffiDestroy?.();
          }
        });
      }
      return null;
    }).pipe(Effect.orElseSucceed(() => null));
});
