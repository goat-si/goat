import type { ProviderDriverKind } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { AcpAdapterV2Flavor } from "./adapterFlavor.ts";

export type PromptOutcomeCheck = Effect.Success<
  ReturnType<NonNullable<AcpAdapterV2Flavor["watchPromptOutcome"]>>
>;

export const readRetiredPromptOutcome = Effect.fn("AcpAdapterV2.readRetiredPromptOutcome")(
  function* (check: PromptOutcomeCheck | undefined, driver: ProviderDriverKind) {
    if (check === undefined) return undefined;
    return yield* check({ stopReason: "end_turn" }, { retired: true }).pipe(
      Effect.timeout("5 seconds"),
      Effect.catchCause((cause) =>
        Effect.logError("Failed to check a silent ACP prompt's outcome", { driver, cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    );
  },
);
