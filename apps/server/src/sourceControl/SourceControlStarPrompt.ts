import { SourceControlProviderKind, type SourceControlStarredInput } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SourceControlBuiltInDrivers from "./builtInDrivers.ts";

/** The prompt always names GOAT's repository, regardless of what a client sends. */
const GOAT_REPOSITORY = "goat-si/goat";

export class SourceControlStarPrompt extends Context.Service<
  SourceControlStarPrompt,
  {
    readonly starred: (input: SourceControlStarredInput) => Effect.Effect<boolean | null>;
  }
>()("goat/sourceControl/SourceControlStarPrompt") {}

const make = Effect.gen(function* () {
  const drivers = yield* SourceControlBuiltInDrivers.SourceControlDrivers;
  return {
    starred: Effect.fn("SourceControlStarPrompt.starred")(function* (
      input: SourceControlStarredInput,
    ) {
      if (input.provider !== SourceControlProviderKind.make("github")) return null;
      const isStarred = drivers.find(({ driver }) => driver.kind === input.provider)?.instance
        .isRepositoryStarred;
      if (isStarred === undefined) return null;
      return yield* isStarred(input.host, GOAT_REPOSITORY);
    }),
  };
});

export const layer = Layer.effect(SourceControlStarPrompt, make).pipe(
  Layer.provide(SourceControlBuiltInDrivers.layer),
);
