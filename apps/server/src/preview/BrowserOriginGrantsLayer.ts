import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
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
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const runSync = Effect.runSyncWith(yield* Effect.context<never>());
  const policyFeed =
    Option.isSome(settings) && settings.value.committedPolicyChanges
      ? yield* settings.value.committedPolicyChanges
      : undefined;
  const blockedHosts = () => {
    if (Option.isNone(settings) || !settings.value.committedPolicy || !policyFeed) return undefined;
    const policy = runSync(settings.value.committedPolicy);
    const pending = runSync(policyFeed.pending);
    if (policy._tag !== "committed" || pending === undefined) return undefined;
    return pending.length === 0
      ? policy.blockedBrowserHosts
      : [...policy.blockedBrowserHosts, ...pending];
  };
  let supported = false;
  let disable = () => Effect.void;
  const service = yield* makeBrowserOriginGrants({
    environmentId,
    supported: () => supported && Option.isSome(manifest),
    blockedHosts,
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
    onFenceFailure: () => disable(),
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
  disable = () => setDriverCapability(false);
  if (policyFeed) {
    yield* policyFeed.changes.pipe(
      Stream.runForEach((batch) =>
        service.blockOrigins(batch.hosts).pipe(Effect.tap(() => Effect.sync(batch.acknowledge))),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* service.blockOrigins(blockedHosts());
  }
  return { ...service, blockedHosts, setDriverCapability };
});

export class BrowserOriginGrants extends Context.Service<
  BrowserOriginGrants,
  Effect.Success<typeof make>
>()("goat/preview/BrowserOriginGrantsLayer/BrowserOriginGrants") {}
export const layer = Layer.effect(BrowserOriginGrants, make);
