import {
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  HandoffError,
  type AuthSessionId,
  type EnvironmentAuthorizationError,
  type Handoff,
  type HandoffReadInput,
  type HandoffRespondInput,
} from "@goat/contracts";
import * as Effect from "effect/Effect";

export const resolve = Effect.fn("Handoffs.resolvePersonStop")(function* ({
  input,
  sessionId,
  read,
  clientLabel,
}: {
  input: HandoffRespondInput;
  sessionId: AuthSessionId | undefined;
  read: (input: HandoffReadInput) => Effect.Effect<Handoff, HandoffError>;
  clientLabel: (
    input: HandoffRespondInput,
    sessionId: AuthSessionId,
  ) => Effect.Effect<string, HandoffError | EnvironmentAuthorizationError>;
}) {
  const label =
    sessionId === undefined ? "Person at this computer" : yield* clientLabel(input, sessionId);
  const record = yield* read(input);
  if (
    sessionId === undefined &&
    (input.action !== "cancelled" || record.target.path !== COMPUTER_USE_GRANT_HANDOFF_PATH)
  )
    return yield* new HandoffError({ reason: "invalid_request" });
  return { label, record };
});

export const markPersonStopped = Effect.fn("Handoffs.markPersonStopped")(function* (
  input: HandoffRespondInput,
  record: Handoff,
  mark: (
    id: string,
    payload: { readonly version: 1; readonly kind: "computer_use_ended" },
    replace: boolean,
  ) => Effect.Effect<void, HandoffError>,
) {
  if (
    record.target.path === COMPUTER_USE_GRANT_HANDOFF_PATH &&
    input.action === "cancelled" &&
    record.state === "completed"
  )
    yield* mark(input.handoffId, { version: 1, kind: "computer_use_ended" }, true);
});

export const session = (sessionId: AuthSessionId | undefined) =>
  sessionId === undefined
    ? Effect.fail(new HandoffError({ reason: "invalid_request" }))
    : Effect.succeed(sessionId);
