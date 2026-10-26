import * as Effect from "effect/Effect";
import type { ScreenHostCall, ScreenRunError, ScreenSurfaceAvailability } from "@goat/contracts";
import type { ScreenHostContext, ScreenHostDispatcher } from "./ScreenHostBridge.ts";

const unavailable = (kind: "app" | "tab"): ScreenRunError => ({
  code: "unavailable",
  effectStarted: false,
  nextStep:
    kind === "app" ? "Start desktop control and try again." : "Open a preview host and try again.",
});

export const createScreenDispatchRouter = (hosts: {
  readonly app?: ScreenHostDispatcher;
  readonly tab?: ScreenHostDispatcher;
}): ScreenHostDispatcher => ({
  availability: Effect.fn("ScreenDispatchRouter.availability")(function* (context) {
    const app = hosts.app
      ? yield* hosts.app.availability(context)
      : [{ kind: "app", available: false, reason: "no_lease" } as const];
    const tab = hosts.tab
      ? yield* hosts.tab.availability(context)
      : [{ kind: "tab", available: false, reason: "no_host" } as const];
    const availability: readonly ScreenSurfaceAvailability[] = [
      ...app.filter((item) => item.kind === "app"),
      ...tab.filter((item) => item.kind === "tab"),
    ];
    return availability;
  }),
  dispatch: (call: ScreenHostCall, context: ScreenHostContext) => {
    const kind =
      call.targetRef?.kind ??
      (call.method === "list_apps" ||
      call.method === "list_windows" ||
      call.method === "bind_app" ||
      call.method === "launch_app"
        ? "app"
        : call.method === "list_tabs" || call.method === "bind_tab" || call.method === "open_tab"
          ? "tab"
          : undefined);
    if (kind === undefined) return Effect.fail({ ...unavailable("app"), code: "target_missing" });
    const host = kind === "app" ? hosts.app : hosts.tab;
    return host ? host.dispatch(call, context) : Effect.fail(unavailable(kind));
  },
});
