import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { call, context, fixture, windows } from "./DesktopTargetHost.testkit.ts";

it.effect("a bound app is named only as the driver reported it, never by the call's own name", () =>
  Effect.gen(function* () {
    const labels: unknown[] = [];
    const label = (_targetId: string, appLabel: unknown) => void labels.push(appLabel);
    const listed = fixture({}, undefined, undefined, label);
    yield* listed.host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", name: "hunter2", window_id: 7 }),
      context,
    );
    // Linux's oversized app list reaches no listing, so the call's name is never confirmed.
    const unlisted = fixture(
      {
        list_apps: { message: "Driver reply exceeded the primitive channel limit." },
        list_windows: (args: { app?: string }) =>
          args.app === "org.example.Editor" ? windows : { windows: [] },
      },
      undefined,
      undefined,
      label,
    );
    yield* unlisted.host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", name: "hunter2", window_id: 7 }),
      context,
    );
    expect(labels).toEqual([
      { kind: "app", bundleId: "org.example.Editor", name: "Editor" },
      { kind: "app", bundleId: undefined, name: undefined },
    ]);
  }),
);
