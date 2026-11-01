import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSetupError, type ProviderAuthState } from "@goat/contracts";
import { PtySpawnError, type PtyProcess, type PtySpawnInput } from "@goat/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ProviderAuthFlow from "./providerAuthFlow.ts";
import { runProviderLoginTerminal } from "./providerLoginTerminal.ts";

const instanceId = ProviderInstanceId.make("terminal-test");
const privateOutput = "private-token callback=https://example.com/?code=secret";

it.effect.each([0, 1])("terminal exit %s publishes only safe completion state", (exitCode) =>
  Effect.gen(function* () {
    let data: ((data: string) => void) | undefined;
    let exit: Parameters<PtyProcess["onExit"]>[0] | undefined;
    let killed = false;
    let detached = 0;
    let spawned: PtySpawnInput | undefined;
    let written = "";
    let size: number[] = [];
    const controller = yield* ProviderAuthFlow.make({
      instanceId,
      credentialBinding: { owner: "provider", key: "terminal" },
      methods: Effect.succeed([
        { id: "login", name: "Login", type: "terminal", description: null },
      ]),
      authenticate: (_, context) =>
        runProviderLoginTerminal({
          pty: {
            spawn: (input) =>
              Effect.sync(() => {
                spawned = input;
                return {
                  pid: 123,
                  write: (input) => {
                    written += input;
                  },
                  resize: (cols, rows) => {
                    size = [cols, rows];
                  },
                  kill: () => {
                    killed = true;
                  },
                  onData: (callback) => {
                    data = callback;
                    return () => {
                      detached++;
                    };
                  },
                  onExit: (callback) => {
                    exit = callback;
                    return () => {
                      detached++;
                    };
                  },
                } satisfies PtyProcess;
              }),
          },
          command: "claude",
          args: ["auth", "login"],
          cwd: "/sandbox/state",
          env: { CLAUDE_CONFIG_DIR: "/sandbox/claude" },
          context,
          failure: (operation, detail) => new ProviderSetupError({ instanceId, operation, detail }),
        }),
      logout: Effect.void,
    });
    const state = (predicate: (state: ProviderAuthState) => boolean, owner = "owner") =>
      controller
        .subscribe(owner)
        .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));
    const start = yield* controller.start("owner");
    assert.strictEqual(
      (yield* state((state) => state.phase === "waiting")).interaction?.type,
      "terminal",
    );
    assert.deepEqual(spawned?.args, ["auth", "login"]);
    assert.strictEqual(spawned?.cwd, "/sandbox/state");
    data!(privateOutput);
    const output = yield* state(
      (state) =>
        state.interaction?.type === "terminal" && state.interaction.output === privateOutput,
    );
    assert.strictEqual(output.credentialOwner, "provider");
    assert.isNull((yield* state(() => true, "other")).interaction);
    yield* controller.respond!("owner", {
      instanceId,
      flowId: start.flowId!,
      interactionId: "terminal",
      response: { type: "terminal", data: "answer", size: { cols: 100, rows: 30 } },
    });
    assert.strictEqual(written, "answer");
    assert.deepEqual(size, [100, 30]);
    exit!({ exitCode, signal: null });
    const finished = yield* state(
      (state) => state.phase === (exitCode === 0 ? "succeeded" : "failed"),
    );
    assert.isNull(finished.interaction);
    assert.notInclude(finished.message ?? "", privateOutput);
    if (exitCode !== 0)
      assert.strictEqual(
        finished.message,
        "The provider login command did not finish successfully.",
      );
    assert.isTrue(killed);
    assert.strictEqual(detached, 2);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("drops native spawn diagnostics from setup errors", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      runProviderLoginTerminal({
        pty: {
          spawn: () =>
            Effect.fail(new PtySpawnError({ adapter: "fake", cause: new Error(privateOutput) })),
        },
        command: "claude",
        args: ["auth", "login"],
        cwd: "/sandbox",
        env: {},
        context: {
          flowId: "flow",
          expiresAt: 0,
          setInteraction: () => Effect.void,
          verifying: Effect.void,
        },
        failure: (operation, detail) => new ProviderSetupError({ instanceId, operation, detail }),
      }),
    );
    assert.strictEqual(error.detail, "Could not open the provider sign-in terminal.");
    assert.isUndefined(error.cause);
    assert.notInclude(JSON.stringify(error), privateOutput);
  }).pipe(Effect.scoped),
);
