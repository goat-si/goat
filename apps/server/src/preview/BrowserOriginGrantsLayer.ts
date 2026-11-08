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
import { BrowserClaimResponder } from "../handoffs/BrowserClaimResponder.ts";

class BrowserClaimBindUnavailable extends Schema.TaggedError<BrowserClaimBindUnavailable>()(
  "BrowserClaimBindUnavailable",
  { cause: Schema.Defect() },
) {}

const make = Effect.gen(function* () {
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const settings = yield* ServerSettings.ServerSettingsService;
  const runSync = Effect.runSyncWith(yield* Effect.context<never>());
  const { environmentId } = yield* environment.getDescriptor;
  const manifest = yield* Effect.serviceOption(BrowserClaimManifest);
  const bind = yield* Effect.serviceOption(BrowserClaimBind);
  let supported = false;
  let disable = () => Effect.void;
  const service = yield* makeBrowserOriginGrants({
    environmentId,
    blockedHostsNow: () => {
      const handle = settings.committedPolicy;
      if (handle?.hostsNow) return handle.hostsNow();
      if (handle === undefined) return undefined;
      const policy = runSync(handle);
      return policy._tag === "committed" && Array.isArray(policy.blockedBrowserHosts)
        ? policy.blockedBrowserHosts
        : undefined;
    },
    blockedHosts:
      settings.blockedBrowserHostsSnapshot ??
      settings.getSettings.pipe(Effect.map((value) => value.blockedBrowserHosts)),
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
    onFenceFailure: () =>
      Option.isSome(manifest) && manifest.value.onFenceFailure
        ? manifest.value.onFenceFailure(disable())
        : disable(),
    markFence: () => (Option.isSome(manifest) ? manifest.value.markFence?.() : undefined),
    onConcurrentFence: (marked) =>
      marked && Option.isSome(manifest) && manifest.value.onFenceFailure
        ? manifest.value.onFenceFailure(disable())
        : disable(),
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
  const responder = yield* Effect.serviceOption(BrowserClaimResponder);
  if (Option.isSome(responder)) yield* responder.value.register(service.answer);
  const policy = settings.committedPolicy;
  const sameHosts = (
    left: ReadonlyArray<string> | undefined,
    right: ReadonlyArray<string> | undefined,
  ) =>
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.length === right.length &&
      left.every((host, index) => host === right[index]));
  if (policy?.changes !== undefined) {
    // Every publication is acknowledged once applied, unchanged ones too, or the bounded history
    // overflows and fails closed. A failed apply stays unacknowledged, so its hosts stay pending.
    let applied: { readonly hosts: ReadonlyArray<string> | undefined } | undefined;
    const acknowledge = Effect.sync(() => policy.acknowledge?.());
    yield* policy.changes.pipe(
      Stream.runForEach((hosts) =>
        applied !== undefined && sameHosts(applied.hosts, hosts)
          ? acknowledge
          : service.blockedHostsChanged(hosts).pipe(
              Effect.andThen(Effect.sync(() => (applied = { hosts }))),
              Effect.andThen(acknowledge),
              Effect.catchCause((cause) =>
                Effect.logError("Could not apply the committed blocked browser hosts", { cause }),
              ),
            ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
  }
  const setDriverCapability = Effect.fn("BrowserOriginGrants.setDriverCapability")(function* (
    value: boolean,
  ) {
    if (supported === value) return;
    if (value) {
      supported = true;
      yield* service.capabilityChanged;
    } else
      yield* service.driverRestarted(() => {
        supported = false;
      });
  });
  disable = () => setDriverCapability(false);
  return { ...service, setDriverCapability };
});

export class BrowserOriginGrants extends Context.Service<
  BrowserOriginGrants,
  Effect.Success<typeof make>
>()("goat/preview/BrowserOriginGrantsLayer/BrowserOriginGrants") {}
export const layer = Layer.effect(BrowserOriginGrants, make);
