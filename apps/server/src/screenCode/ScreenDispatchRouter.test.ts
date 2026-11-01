import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { ScreenHostCall } from "@goat/contracts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import type { ScreenHostContext } from "./ScreenHostBridge.ts";

const context = { runId: "r", turnId: "t" } as ScreenHostContext;
const call = (kind?: "app" | "tab"): ScreenHostCall => ({
  t: "call",
  runId: "r",
  turnId: "t",
  cellId: "c",
  callId: 1,
  ...(kind
    ? {
        targetRef: {
          id: "target",
          kind,
          environmentId: "env",
          runId: "r",
          turnId: "t",
          generation: 1,
        },
      }
    : {}),
  method: kind ? "click" : "list_apps",
  args: {},
  deadlineMillis: 1,
});

it.effect("routes each target to its host and reports a missing tab host", () =>
  Effect.gen(function* () {
    const router = createScreenDispatchRouter({
      app: {
        availability: () => Effect.succeed([{ kind: "app", available: true }]),
        dispatch: () => Effect.succeed({ category: "unverifiable", value: "app" }),
      },
    });
    expect((yield* router.dispatch(call("app"), context)).value).toBe("app");
    expect((yield* router.dispatch(call(), context)).value).toBe("app");
    const missing = yield* router.dispatch(call("tab"), context).pipe(Effect.result);
    expect(missing._tag).toBe("Failure");
    if (missing._tag === "Failure") expect(missing.failure.code).toBe("unavailable");
    expect(yield* router.availability(context)).toEqual([
      { kind: "app", available: true },
      { kind: "tab", available: false, reason: "no_host" },
    ]);
  }),
);

it.effect("routes targetless tab discovery and binding to the tab host", () =>
  Effect.gen(function* () {
    const routed: string[] = [];
    const router = createScreenDispatchRouter({
      app: {
        availability: () => Effect.succeed([{ kind: "app", available: true }]),
        dispatch: () => Effect.succeed({ category: "confirmed", value: "app" }),
      },
      tab: {
        availability: () => Effect.succeed([{ kind: "tab", available: true }]),
        dispatch: (request) =>
          Effect.sync(() => {
            routed.push(request.method);
            return { category: "confirmed" as const, value: "tab" };
          }),
      },
    });
    for (const method of ["list_tabs", "select_tab", "open_tab"] as const) {
      expect((yield* router.dispatch({ ...call(), method }, context)).value).toBe("tab");
    }
    expect(routed).toEqual(["list_tabs", "select_tab", "open_tab"]);
    expect(yield* router.availability(context)).toEqual([
      { kind: "app", available: true },
      { kind: "tab", available: true },
    ]);
  }),
);
