import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { BrowserClaimBind } from "./BrowserClaimBind.ts";
import { BrowserClaimManifest } from "./BrowserClaimManifest.ts";
import { makeBrowserOriginGrants } from "./BrowserOriginGrants.ts";

class BrowserClaimBindUnavailable extends Schema.TaggedError<BrowserClaimBindUnavailable>()(
  "BrowserClaimBindUnavailable",
  { cause: Schema.Defect() },
) {}

const make = Effect.gen(function* () {
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const { environmentId } = yield* environment.getDescriptor;
  const manifest = yield* Effect.serviceOption(BrowserClaimManifest);
  const bind = yield* Effect.serviceOption(BrowserClaimBind);
  let supported = false;
  const service = yield* makeBrowserOriginGrants({
    environmentId,
    supported: () => supported && Option.isSome(manifest),
    bindAvailable: () => Option.isSome(bind),
    publish: (union) =>
      Option.isSome(manifest)
        ? manifest.value.publish(union)
        : Effect.fail(
            new BrowserClaimBindUnavailable({ cause: "Browser manifest is unavailable." }),
          ),
    fence: () =>
      Option.isSome(manifest) && manifest.value.fence
        ? manifest.value.fence
        : Effect.succeed(false),
    confirm: () =>
      Option.isSome(manifest)
        ? manifest.value.readConfig
        : Effect.fail(
            new BrowserClaimBindUnavailable({ cause: "Driver configuration is unavailable." }),
          ),
    windowTitle: (request) =>
      Option.isSome(bind) && bind.value.windowTitle
        ? bind.value.windowTitle(request)
        : Effect.fail(new BrowserClaimBindUnavailable({ cause: "Window listing is unavailable." })),
    bind: (request) =>
      Option.isSome(bind)
        ? bind.value.bind(request)
        : Effect.fail(
            new BrowserClaimBindUnavailable({ cause: "Browser claim binding is unavailable." }),
          ),
  });
  const setDriverCapability = Effect.fn("BrowserOriginGrants.setDriverCapability")(function* (
    value: boolean,
  ) {
    if (supported === value) return;
    if (value) supported = true;
    else
      yield* service.driverRestarted(() => {
        supported = false;
      });
  });
  return { ...service, setDriverCapability };
});

export class BrowserOriginGrants extends Context.Service<
  BrowserOriginGrants,
  Effect.Success<typeof make>
>()("goat/preview/BrowserOriginGrantsLayer/BrowserOriginGrants") {}
export const layer = Layer.effect(BrowserOriginGrants, make);
