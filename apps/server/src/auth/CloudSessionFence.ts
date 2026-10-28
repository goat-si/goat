import type { AuthSessionId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { ServerSecretStore } from "./ServerSecretStore.ts";
import { UnknownSessionTokenError } from "./SessionStore.ts";
import { CLOUD_WITHDRAWAL_FENCE } from "../cloud/config.ts";

export const make = Effect.fn("CloudSessionFence.make")(function* (
  initial: ReadonlyArray<{ readonly sessionId: AuthSessionId; readonly subject: string }>,
  invalidate: (id: AuthSessionId) => Effect.Effect<void>,
) {
  const secrets = yield* ServerSecretStore;
  const pending = yield* Ref.make(
    Option.isSome(yield* secrets.get(CLOUD_WITHDRAWAL_FENCE).pipe(Effect.orDie)),
  );
  const ids = new Set(
    initial.filter((row) => row.subject === "cloud-connect").map((row) => row.sessionId),
  );
  const denied = (id: AuthSessionId) =>
    Ref.get(pending).pipe(Effect.map((value) => value && ids.has(id)));
  const setPending = Effect.fn("CloudSessionFence.setPending")(function* (value: boolean) {
    yield* Ref.set(pending, value);
    if (value) yield* Effect.forEach(ids, invalidate, { discard: true });
  });
  const observe = Effect.fn("CloudSessionFence.observe")(function* (session: {
    sessionId: AuthSessionId;
    subject: string;
  }) {
    if (session.subject === "cloud-connect") {
      ids.add(session.sessionId);
      if (yield* Ref.get(pending)) yield* invalidate(session.sessionId);
    }
  });
  const guardId = Effect.fn("CloudSessionFence.guardId")(function* (id: AuthSessionId) {
    if (yield* denied(id)) return yield* new UnknownSessionTokenError({ sessionId: id });
  });
  const guard = Effect.fn("CloudSessionFence.guard")(function* (session: {
    sessionId: AuthSessionId;
    subject: string;
  }) {
    yield* observe(session);
    yield* guardId(session.sessionId);
  });
  yield* setPending(yield* Ref.get(pending));
  return { observe, guard, guardId, denied, setPending };
});
