import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { parseGoalCommand, type ProviderDriverKind, type ThreadId } from "@goat/contracts";
import type { CodexSurvivors } from "../../provider/CodexSurvivors.ts";

export const refuseCodexAdmission = Effect.fn("CodexTurnAdmission.refuse")(function* <E>(input: {
  readonly survivors: Option.Option<CodexSurvivors["Service"]>;
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly message?: { readonly text: string; readonly attachments?: ReadonlyArray<unknown> };
  readonly settle: (input: {
    readonly signal: string;
    readonly title: string;
    readonly error: Error;
    readonly message?: string;
  }) => Effect.Effect<void, E>;
}) {
  if (input.driver !== "codex" || Option.isNone(input.survivors)) return false;
  const command = input.message === undefined ? null : parseGoalCommand(input.message);
  const allowGoalControl =
    command?.type === "pause" || command?.type === "clear" || command?.type === "show";
  const admission = yield* input.survivors.value
    .ensureAdmission(input.threadId, { allowGoalControl })
    .pipe(Effect.result);
  if (admission._tag === "Success") return false;
  yield* input.settle({
    signal: "codex-admission",
    title: "Codex cannot start this turn",
    error: admission.failure,
    message: admission.failure.message,
  });
  return true;
});
