import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Request } from "./BrowserOriginGrants.ts";

export class BrowserClaimBind extends Context.Service<
  BrowserClaimBind,
  {
    readonly bind: (request: Request) => Effect.Effect<
      {
        readonly tabId: string;
        readonly title: string;
        readonly url: string;
        readonly driverGeneration: number;
      },
      Error
    >;
  }
>()("goat/preview/BrowserClaimBind") {}
