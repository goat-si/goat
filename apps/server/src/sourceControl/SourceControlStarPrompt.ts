import {
  SourceControlProviderKind,
  WS_METHODS,
  type SourceControlStarredInput,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SourceControlBuiltInDrivers from "./builtInDrivers.ts";

/** The prompt always names GOAT's repository, regardless of what a client sends. */
const GOAT_REPOSITORY = "goat-si/goat";
const GITHUB_HOST = "github.com";

export class SourceControlStarPrompt extends Context.Service<
  SourceControlStarPrompt,
  {
    readonly starred: (input: SourceControlStarredInput) => Effect.Effect<boolean | null>;
    readonly star: (input: SourceControlStarredInput) => Effect.Effect<boolean>;
  }
>()("goat/sourceControl/SourceControlStarPrompt") {}

export const make = Effect.gen(function* () {
  const drivers = yield* SourceControlBuiltInDrivers.SourceControlDrivers;
  return {
    starred: Effect.fn("SourceControlStarPrompt.starred")(function* (
      input: SourceControlStarredInput,
    ) {
      if (input.provider !== SourceControlProviderKind.make("github")) return null;
      const isStarred = drivers.find(({ driver }) => driver.kind === input.provider)?.instance
        .isRepositoryStarred;
      if (isStarred === undefined) return null;
      return yield* isStarred(GITHUB_HOST, GOAT_REPOSITORY);
    }),
    star: Effect.fn("SourceControlStarPrompt.star")(function* (input: SourceControlStarredInput) {
      const star = drivers.find(({ driver }) => driver.kind === input.provider)?.instance
        .starRepository;
      return star === undefined ? false : yield* star(GITHUB_HOST, GOAT_REPOSITORY);
    }),
  };
});

/**
 * RPC handlers for the star prompt. Kept here so `ws.ts` only adds one spread line instead of one
 * handler line per method; the repository is still pinned server-side by `starred`/`star` above.
 */
export const handlers = (service: SourceControlStarPrompt["Service"]) => ({
  [WS_METHODS.sourceControlStarred]: (input: SourceControlStarredInput) => service.starred(input),
  [WS_METHODS.sourceControlStar]: (input: SourceControlStarredInput) => service.star(input),
});

export const makeLayer = Effect.map(make, (service) =>
  Layer.succeed(SourceControlStarPrompt, service),
);
