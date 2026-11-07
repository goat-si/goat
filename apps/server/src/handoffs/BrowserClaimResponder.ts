import { HandoffError } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type { makeBrowserOriginGrants } from "../preview/BrowserOriginGrants.ts";

type Grants = Effect.Success<ReturnType<typeof makeBrowserOriginGrants>>;
type Answer = Grants["answer"];

export class BrowserClaimResponder extends Context.Service<
  BrowserClaimResponder,
  {
    readonly register: (answer: Answer) => Effect.Effect<void>;
    readonly answer: (
      claimId: string,
      approved: boolean,
    ) => Effect.Effect<Effect.Success<ReturnType<Answer>>, HandoffError>;
  }
>()("goat/handoffs/BrowserClaimResponder") {}

export const layer = Layer.effect(
  BrowserClaimResponder,
  Effect.gen(function* () {
    const current = yield* Ref.make<Option.Option<Answer>>(Option.none());
    return BrowserClaimResponder.of({
      register: Effect.fn("BrowserClaimResponder.register")((answer) =>
        Ref.set(current, Option.some(answer)),
      ),
      answer: Effect.fn("BrowserClaimResponder.answer")((claimId, approved) =>
        Ref.get(current).pipe(
          Effect.flatMap((answer) =>
            Option.isSome(answer)
              ? answer
                  .value(claimId, approved)
                  .pipe(
                    Effect.mapError((cause) => new HandoffError({ reason: "unavailable", cause })),
                  )
              : Effect.fail(
                  new HandoffError({
                    reason: "unavailable",
                    detail: "Browser claims are unavailable.",
                  }),
                ),
          ),
        ),
      ),
    });
  }),
);
