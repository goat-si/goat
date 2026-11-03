import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { CuaDriver } from "../cua/CuaDriver.ts";
import { makeBrowserDriverRequest } from "../cua/BrowserDriverCapabilityProbe.ts";
import { BrowserOriginGrants } from "./BrowserOriginGrantsLayer.ts";
import { BrowserClaimWindowsUnavailable, listBrowserClaimWindows } from "./BrowserClaimWindows.ts";
import { makeBrowserClaimsRpcHandlers } from "./BrowserClaimsRpcHandlers.ts";

export const makeBrowserClaimWindows = Effect.fn("BrowserClaimWindows.make")(function* () {
  const grants = yield* Effect.serviceOption(BrowserOriginGrants);
  const driver = yield* Effect.serviceOption(CuaDriver);
  const request = yield* makeBrowserDriverRequest();
  return () =>
    Effect.gen(function* () {
      if (
        Option.isNone(grants) ||
        !(yield* grants.value.claimsSupported) ||
        Option.isNone(driver) ||
        !driver.value.driverSession
      )
        return yield* new BrowserClaimWindowsUnavailable({
          cause: "Browser windows are unavailable.",
        });
      const session = yield* driver.value.driverSession;
      if (Option.isNone(session))
        return yield* new BrowserClaimWindowsUnavailable({
          cause: "Browser windows are unavailable.",
        });
      return yield* listBrowserClaimWindows((tool, args) =>
        request(session.value.mcp, "tools/call", tool, args),
      );
    });
});

export const makeBrowserClaimsHandlersLive = Effect.fn("BrowserClaimsRpcHandlers.makeLive")(
  function* (session: { readonly subject: string }) {
    const grants = yield* Effect.serviceOption(BrowserOriginGrants);
    const windows = yield* makeBrowserClaimWindows();
    return makeBrowserClaimsRpcHandlers(grants, session, windows);
  },
);
