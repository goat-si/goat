import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { startsNoModelTurn } from "./TurnModelGate.ts";

const instanceId = ProviderInstanceId.make("codex");
const threadId = ThreadId.make("thread-gate");
const survivedRun = RunId.make("run-survived");
const survivors = (sourceRunId: RunId | undefined) =>
  Option.some({
    get: () => Effect.succeed(sourceRunId === undefined ? undefined : { sourceRunId }),
  });
const run = (input: { readonly restartContinuationOfRunId?: RunId }) => ({
  threadId,
  modelSelection: { instanceId, model: "combo/deepseek-flash-pool" },
  ...input,
});

it.effect("adopting a Codex turn that survived a restart opens without the model check", () =>
  Effect.gen(function* () {
    const continuation = run({ restartContinuationOfRunId: survivedRun });
    assert.isTrue(yield* startsNoModelTurn(survivors(survivedRun), continuation, undefined));
    // Without a binding for that run there is nothing to adopt, so a native turn will be sent.
    assert.isFalse(
      yield* startsNoModelTurn(survivors(RunId.make("other")), continuation, undefined),
    );
    assert.isFalse(yield* startsNoModelTurn(survivors(undefined), continuation, undefined));
    assert.isFalse(yield* startsNoModelTurn(Option.none(), continuation, undefined));
  }),
);

it.effect("goal commands that only read or change the goal skip the model check", () =>
  Effect.gen(function* () {
    const plain = run({});
    for (const text of ["/goal", "/goal pause", "/goal clear"])
      assert.isTrue(yield* startsNoModelTurn(Option.none(), plain, { text }), text);
    for (const text of ["/goal ship the release", "/goal resume", "hi"])
      assert.isFalse(yield* startsNoModelTurn(Option.none(), plain, { text }), text);
  }),
);
