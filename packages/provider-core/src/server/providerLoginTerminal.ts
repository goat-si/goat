import type { ProviderSetupError } from "@goat/contracts";
import type * as PtyAdapter from "@goat/shared/PtyAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type { ProviderAuthFlowContext } from "./providerAuthFlow.ts";

export const runProviderLoginTerminal = Effect.fnUntraced(function* (options: {
  readonly pty: PtyAdapter.PtyAdapter["Service"];
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly context: ProviderAuthFlowContext;
  readonly failure: (operation: string, detail: string) => ProviderSetupError;
}) {
  const exited = yield* Deferred.make<number>();
  const output = yield* Queue.sliding<string>(64);
  const process = yield* options.pty
    .spawn({
      shell: options.command,
      args: [...options.args],
      cwd: options.cwd,
      cols: 80,
      rows: 24,
      env: options.env,
    })
    .pipe(
      Effect.mapError(() =>
        options.failure("start", "Could not open the provider sign-in terminal."),
      ),
    );
  const detachData = process.onData((data) => {
    Queue.offerUnsafe(output, data.slice(-16_384));
  });
  const detachExit = process.onExit(({ exitCode }) => {
    Deferred.doneUnsafe(exited, Effect.succeed(exitCode));
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      detachData();
      detachExit();
      try {
        process.kill();
      } catch {}
    }),
  );
  let transcript = "";
  let outputOffset = 0;
  const update = () =>
    options.context.setInteraction(
      { type: "terminal", id: "terminal", output: transcript, outputOffset },
      (response) =>
        response.type === "terminal"
          ? Effect.try({
              try: () => {
                if (response.size) process.resize(response.size.cols, response.size.rows);
                if (response.data) process.write(response.data);
              },
              catch: () =>
                options.failure("respond", "The provider sign-in terminal is no longer available."),
            })
          : Effect.void,
    );
  yield* update();
  yield* Queue.take(output).pipe(
    Effect.flatMap((data) => {
      outputOffset += data.length;
      transcript = (transcript + data).slice(-16_384);
      return update();
    }),
    Effect.forever,
    Effect.forkScoped,
  );
  if ((yield* Deferred.await(exited)) !== 0)
    return yield* options.failure(
      "start",
      "The provider login command did not finish successfully.",
    );
});
