import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { reserveProxyCall } from "./ComputerUseLeaseProxyAdmission.ts";
import { parse } from "./ComputerUseLeaseProtocol.ts";
import { deniedCallApp } from "./ComputerUseCallSafety.ts";

it.effect("refuses a batch alias shared with a denied app", () =>
  Effect.gen(function* () {
    const executable = "C:\\Shared\\host.exe";
    const result = yield* reserveProxyCall(
      {
        controlId: "control",
        bundleIds: false,
        reservation: (request) =>
          Effect.sync(() => {
            if (request.action !== "reserve") return { status: "released" } as const;
            const app = deniedCallApp(request, ["com.example.Blocked"]);
            return app === undefined
              ? ({ status: "admitted", reservationId: null } as const)
              : ({ status: "refused", detail: "app_not_allowed", app } as const);
          }),
      },
      {
        id: 1,
        message:
          parse(
            JSON.stringify({
              method: "tools/call",
              params: {
                name: "run_steps",
                arguments: { app_scope: { apps: [executable], delivery: "background" }, steps: [] },
              },
            }),
          ) ?? {},
        connectionId: "driver",
        callId: "one",
        interruptions: 0,
        idleEpoch: 0,
        foreground: [],
        scope: {
          listed: new Map([
            [1, { id: "com.example.Allowed", name: "Allowed", executable }],
            [2, { id: "com.example.Blocked", name: "Blocked", executable }],
          ]),
          apps: undefined,
        },
      },
    );
    assert.include(result.refused ?? "", "app_not_allowed");
  }),
);

it.effect("includes a known pid's app when a desktop-wide call reserves", () =>
  Effect.gen(function* () {
    let app: string | undefined;
    yield* reserveProxyCall(
      {
        controlId: "control",
        bundleIds: true,
        reservation: (request) =>
          Effect.sync(() => {
            if (request.action === "reserve") app = request.app;
            return { status: "refused", detail: "app_not_allowed" } as const;
          }),
      },
      {
        id: 1,
        message:
          parse(
            JSON.stringify({
              method: "tools/call",
              params: {
                name: "click",
                arguments: { pid: 42, window_id: 1, delivery_mode: "foreground" },
              },
            }),
          ) ?? {},
        connectionId: "driver",
        callId: "one",
        interruptions: 0,
        idleEpoch: 0,
        foreground: [],
        scope: {
          listed: new Map([[42, { id: "com.example.Blocked", name: "Editor" }]]),
          apps: undefined,
        },
      },
    );
    assert.equal(app, "com.example.Blocked");
  }),
);

it.effect("carries the bundle identity when a grant names the executable", () =>
  Effect.gen(function* () {
    let identities: ReadonlyArray<string> | undefined;
    yield* reserveProxyCall(
      {
        controlId: "control",
        bundleIds: true,
        reservation: (request) =>
          Effect.sync(() => {
            if (request.action === "reserve") identities = request.safetyApps;
            return { status: "refused", detail: "app_not_allowed" } as const;
          }),
      },
      {
        id: 1,
        message:
          parse(
            JSON.stringify({
              method: "tools/call",
              params: { name: "click", arguments: { pid: 42, window_id: 1 } },
            }),
          ) ?? {},
        connectionId: "driver",
        callId: "one",
        interruptions: 0,
        idleEpoch: 0,
        foreground: [],
        scope: {
          listed: new Map([
            [42, { id: "com.example.Blocked", name: "Editor", executable: "/example/editor" }],
          ]),
          apps: new Set(["/example/editor"]),
        },
      },
    );
    assert.include(identities ?? [], "com.example.Blocked");
  }),
);
