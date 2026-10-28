import { expect, it } from "@effect/vitest";
import { ThreadId, TurnItemId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { makeCallApps, type ScreenTargetLabel } from "../cua/ComputerUseCallApps.ts";
import { call, context, fixture, windows } from "./DesktopTargetHost.testkit.ts";

const oversized = { message: "Driver reply exceeded the primitive channel limit." };
const cellRow = (targetId: string) => ({
  id: TurnItemId.make("cell-row"),
  type: "dynamic_tool" as const,
  threadId: ThreadId.make("thread"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: null,
  toolName: "goat.goat_screen_run",
  input: { code: "..." },
  output: { journal: [{ receipt: { callId: 1, targetId, method: "click" } }] },
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-10-29T00:00:00.000Z"),
});

it.effect(
  "a bound app is named only as the driver reported it; the call's own words name nothing",
  () =>
    Effect.gen(function* () {
      const labels: ScreenTargetLabel[] = [];
      const label = (_targetId: string, appLabel: ScreenTargetLabel) => void labels.push(appLabel);
      const bind = (overrides: Record<string, unknown>, args: Record<string, unknown>) =>
        fixture(overrides, undefined, undefined, label).host.bindApp(
          call("bind_app", { ...args, window_id: 7 }),
          context,
        );
      yield* bind({}, { bundle_id: "org.example.Editor", name: "hunter2" });
      // Linux's oversized app list reaches no listing, and this window reports no app name: the
      // driver's app filter also matches names, so the call's bundle_id is not a confirmed id.
      yield* bind(
        {
          list_apps: oversized,
          list_windows: (args: { app?: string }) =>
            args.app === "hunter2" ? windows : { windows: [] },
        },
        { bundle_id: "hunter2", name: "hunter2" },
      );
      expect(labels).toEqual([
        {
          kind: "app",
          bundleId: "org.example.Editor",
          name: "Editor",
          iconBundleId: "org.example.Editor",
        },
        { kind: "app", bundleId: undefined, name: undefined, iconBundleId: "hunter2" },
      ]);

      const apps = makeCallApps();
      const cell = { runId: "r", turnId: "t", cellId: "c" };
      apps.screenTarget("listed", labels[0]!, cell);
      apps.screenTarget("unlisted", labels[1]!, cell);
      expect(apps.takeCellSubjects(cell, ["listed", "unlisted"])).toEqual(["Editor"]);
      // The unconfirmed id may still pick the icon, under a generic name.
      const row = apps.present(cellRow("unlisted"));
      expect(row.toolIcon).toEqual({
        _tag: "native-app",
        app: { _tag: "app-id", appId: "hunter2" },
      });
      expect(row.toolSource?.name).toBe("app");
      expect(row.title).toBeNull();
    }),
);
