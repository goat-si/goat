import { ProviderSetupError, type ClaudeSettings, type ProviderInstanceId } from "@goat/contracts";
import * as ProviderAuthFlow from "@goat/provider-core/server/providerAuthFlow";
import { runProviderLoginTerminal } from "@goat/provider-core/server/providerLoginTerminal";
import type * as PtyAdapter from "@goat/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { resolveClaudeSdkExecutablePath } from "./ClaudeExecutable.ts";
import { makeClaudeEnvironment, resolveClaudeHomePath } from "./ClaudeHome.ts";

export const makeClaudeAuth = Effect.fn("makeClaudeAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly config: ClaudeSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly pty: PtyAdapter.PtyAdapter["Service"];
  readonly onChanged: Effect.Effect<void>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* makeClaudeEnvironment(options.config, options.environment);
  const binary = yield* resolveClaudeSdkExecutablePath(options.config.binaryPath, environment);
  const configDir = yield* resolveClaudeHomePath(options.config, environment);
  const failure = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail });
  // Auth diagnostics can contain credentials or callback URLs. Discard both streams
  // and never attach native errors to the public setup error.
  const run = (action: "status" | "logout") =>
    spawner
      .exitCode(
        ChildProcess.make(binary, ["auth", action], {
          cwd: options.cwd,
          env: environment,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(
        Effect.mapError(() => failure(action, "Could not run the Claude authentication command.")),
        Effect.flatMap((code) =>
          Number(code) === 0
            ? Effect.void
            : Effect.fail(failure(action, "Claude could not confirm the authentication change.")),
        ),
      );
  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "provider", key: `claude:${configDir}:${binary}` },
    methods: Effect.succeed([
      {
        id: "claude-login",
        name: "Sign in with Claude",
        type: "terminal",
        description: "Sign in using the official Claude Code CLI.",
      },
    ]),
    defaultMethodId: "claude-login",
    authenticate: (_, context) =>
      Effect.gen(function* () {
        yield* runProviderLoginTerminal({
          pty: options.pty,
          command: binary,
          args: ["auth", "login"],
          cwd: options.cwd,
          env: environment,
          context,
          failure,
        }).pipe(Effect.scoped);
        yield* context.verifying;
        yield* run("status");
        yield* options.onChanged;
      }),
    logout: run("logout").pipe(Effect.andThen(options.onChanged)),
  });
});
