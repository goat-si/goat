import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Union } from "./BrowserOriginGrants.ts";

export class BrowserClaimManifest extends Context.Service<
  BrowserClaimManifest,
  {
    readonly publish: (union: Union) => Effect.Effect<void, Error>;
  }
>()("goat/preview/BrowserClaimManifest") {}
