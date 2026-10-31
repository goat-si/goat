import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { reserveProxyCall } from "./ComputerUseLeaseProxyAdmission.ts";
import { parse } from "./ComputerUseLeaseProtocol.ts";

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
