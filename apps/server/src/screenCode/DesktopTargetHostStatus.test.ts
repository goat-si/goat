import { expect, it } from "@effect/vitest";
import { DEFAULT_SCREEN_RUN_LIMITS, type ScreenHostCall } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { ComputerUseLeases } from "../cua/ComputerUseLeases.ts";
import type { ComputerUsePrimitiveChannel } from "../cua/ComputerUsePrimitiveChannel.ts";
import { createDesktopTargetHost } from "./DesktopTargetHost.ts";
import type { ScreenHostContext } from "./ScreenHostBridge.ts";

it.effect("browser-only reads on a desktop target refuse before accessing desktop control", () =>
  Effect.gen(function* () {
    const unavailable = {
      get: () => {
        throw new Error("Desktop control must not be accessed");
      },
    };
    const host = createDesktopTargetHost({
      leases: new Proxy({} as ComputerUseLeases["Service"], unavailable),
      primitiveChannel: new Proxy({} as ComputerUsePrimitiveChannel["Service"], unavailable),
    });
    const context = {
      runId: "run",
      turnId: "turn",
      cellId: "cell",
      environmentId: "env",
      threadId: "thread",
      limits: DEFAULT_SCREEN_RUN_LIMITS,
    } as ScreenHostContext;
    for (const method of ["tab_status", "read_page"] as const) {
      const call: ScreenHostCall = {
        t: "call",
        runId: "run",
        turnId: "turn",
        cellId: "cell",
        callId: 1,
        method,
        args: [{}],
        deadlineMillis: 1000,
        targetRef: {
          id: "app",
          kind: "app",
          environmentId: "env",
          runId: "run",
          turnId: "turn",
          generation: 0,
        },
      };
      const result = yield* host.dispatch(call, context).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({ code: "unsupported", effectStarted: false });
    }
  }),
);
