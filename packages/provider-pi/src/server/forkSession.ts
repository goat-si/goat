import type { ProviderDriverKind } from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { PiAdapterV2Options } from "./adapter.ts";
import type { PiRuntimeProfile } from "./profile.ts";
import { buildPiRpcLaunch } from "./mcpInjection.ts";
import {
  makePiRpcConnection,
  piRecordField as recordField,
  piRecordString as recordString,
} from "./rpc.ts";
import { readPiEntries } from "./entries.ts";
import { piForkEntry, type PiForkBoundary } from "./forkBoundary.ts";

export const forkPiSession = Effect.fnUntraced(function* ({
  sourceFile,
  boundary,
  createdAt,
  cwd,
  driver,
  profile,
  options,
  launchArgs,
  spawner,
}: {
  sourceFile: string;
  boundary: PiForkBoundary;
  createdAt: DateTime.Utc;
  cwd: string;
  driver: ProviderDriverKind;
  profile: PiRuntimeProfile;
  options: PiAdapterV2Options;
  launchArgs: ReadonlyArray<string>;
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}) {
  const protocolError = (detail: string) =>
    new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail });
  const forkLaunch = buildPiRpcLaunch({
    launchArgs: launchArgs,
    environment: yield* options.currentEnvironment ?? Effect.succeed(options.environment),
    mcpSession: undefined,
    extensionPath: undefined,
    shortLived: true,
    disableExtensions: true,
    disableTools: true,
    profile,
  });
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const forkConnection = yield* makePiRpcConnection({
        command: options.settings.binaryPath || profile.defaultBinary,
        args: [...forkLaunch.args, "--fork", sourceFile],
        cwd,
        env: forkLaunch.env,
      });
      yield* Stream.fromQueue(forkConnection.events).pipe(
        Stream.runDrain,
        Effect.ignore,
        Effect.forkScoped,
      );
      const beforeEntry =
        boundary.type === "nothing"
          ? null
          : yield* piForkEntry(
              driver,
              boundary,
              createdAt,
              readPiEntries(profile.pagedEntries, (input) => forkConnection.request(input)),
            );
      if (beforeEntry !== null) {
        const result = yield* forkConnection.request({
          type: "fork",
          entryId: beforeEntry,
        });
        if (recordField(result, "cancelled") === true) {
          return yield* protocolError("A Pi extension cancelled the session fork");
        }
      }
      const state = yield* forkConnection.request({ type: "get_state" });
      const file = recordString(state, "sessionFile");
      if (file === undefined || file === sourceFile) {
        return yield* protocolError("Pi fork did not create a distinct session file");
      }
      return file;
    }),
  ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
});
