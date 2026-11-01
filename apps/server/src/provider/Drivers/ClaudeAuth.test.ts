import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSettings, ProviderInstanceId, type ProviderAuthState } from "@goat/contracts";
import type { PtyProcess, PtySpawnInput } from "@goat/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { makeClaudeAuth } from "./ClaudeAuth.ts";

const config = Schema.decodeSync(ClaudeSettings)({
  binaryPath: "claude",
  homePath: "/sandbox/claude",
});

it.effect.each([0, 1])("Claude login requires auth status success (%s)", (statusCode) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    let exit: Parameters<PtyProcess["onExit"]>[0] | undefined;
    let spawned: PtySpawnInput | undefined;
    const commands: Array<ReadonlyArray<string>> = [];
    let refreshed = 0;
    const controller = yield* makeClaudeAuth({
      instanceId: ProviderInstanceId.make("claude-auth-test"),
      config,
      environment: { HOME: "/sandbox", INSTANCE_VARIABLE: "preserved" },
      cwd: "/sandbox/state",
      pty: {
        spawn: (input) =>
          Effect.sync(() => {
            spawned = input;
            return {
              pid: 123,
              write: () => {},
              resize: () => {},
              kill: () => {},
              onData: () => () => {},
              onExit: (callback) => {
                exit = callback;
                return () => {};
              },
            } satisfies PtyProcess;
          }),
      },
      onChanged: Effect.sync(() => {
        refreshed++;
      }),
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
        ...spawner,
        exitCode: (command) =>
          Effect.sync(() => {
            assert.strictEqual(command._tag, "StandardCommand");
            if (command._tag === "StandardCommand") {
              commands.push(command.args);
              assert.strictEqual(command.options.cwd, "/sandbox/state");
              assert.strictEqual(command.options.stdout, "ignore");
              assert.strictEqual(command.options.stderr, "ignore");
            }
            return ChildProcessSpawner.ExitCode(statusCode);
          }),
      }),
    );
    const phase = (phase: ProviderAuthState["phase"]) =>
      controller.subscribe("owner").pipe(
        Stream.filter((state) => state.phase === phase),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
    yield* controller.start("owner");
    yield* phase("waiting");
    assert.deepEqual(spawned?.args, ["auth", "login"]);
    assert.strictEqual(spawned?.cwd, "/sandbox/state");
    assert.deepEqual(spawned?.env, {
      HOME: "/sandbox",
      INSTANCE_VARIABLE: "preserved",
      CLAUDE_CONFIG_DIR: "/sandbox/claude",
    });
    assert.deepEqual(controller.credentialBinding, {
      owner: "provider",
      key: "claude:/sandbox/claude:claude",
    });
    exit!({ exitCode: 0, signal: null });
    yield* phase(statusCode === 0 ? "succeeded" : "failed");
    assert.strictEqual(refreshed, statusCode === 0 ? 1 : 0);
    assert.lengthOf(commands, 1);
    assert.deepEqual(commands[0], ["auth", "status"]);
    if (statusCode === 0) {
      yield* controller.logout(Effect.void);
      assert.strictEqual(refreshed, 2);
      assert.lengthOf(commands, 2);
      assert.deepEqual(commands[1], ["auth", "logout"]);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
