import { expect, it } from "@effect/vitest";
import { ThreadId, TurnItemId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { makeCallApps, type ScreenTargetLabel } from "../cua/ComputerUseCallApps.ts";

import { call, context, fixture, windows } from "./DesktopTargetHost.testkit.ts";

it.effect(
  "a bound app is named only as the driver reported it, never by the call's own name, and keeps its icon",
  () =>
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
        // The bundle id that matched the window still names the icon.
        { kind: "app", bundleId: "org.example.Editor", name: undefined },
      ]);
      const apps = makeCallApps();
      apps.screenTarget("bound", labels[1] as ScreenTargetLabel);
      const row = apps.present({
        id: TurnItemId.make("cell-row"),
        type: "dynamic_tool",
        threadId: ThreadId.make("thread"),
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        toolName: "goat.goat_screen_run",
        input: { code: "..." },
        output: { journal: [{ receipt: { callId: 1, targetId: "bound", method: "click" } }] },
        startedAt: null,
        completedAt: null,
        updatedAt: DateTime.makeUnsafe("2026-10-29T00:00:00.000Z"),
      });
      expect(row.toolIcon).toEqual({
        _tag: "native-app",
        app: { _tag: "app-id", appId: "org.example.Editor" },
      });
      expect(apps.takeCellSubjects({ runId: "r", turnId: "t", cellId: "c" }, ["bound"])).toEqual([
        "org.example.Editor",
      ]);
      expect(JSON.stringify(row)).not.toContain("hunter2");
    }),
);
