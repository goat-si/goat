import type { OpenCodexSyncReport } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { openCodexSyncNotes, shownReport, syncAction, syncRowView } from "./openCodexSync.logic";

const plan: OpenCodexSyncReport = {
  trigger: "plan",
  checkedAt: 1,
  members: [
    { alias: null, state: "ready", restartCodex: false, reason: "busy" },
    { alias: "mac-studio", state: "skipped", restartCodex: false, reason: "not-connected" },
    { alias: "mini", state: "skipped", restartCodex: false, reason: "busy" },
  ],
};

describe("Sync OpenCodex dialog", () => {
  it("tells a busy Home it still syncs, and sends a disconnected Child to Repair", () => {
    expect(plan.members.map((member) => syncRowView(member, "This Mac").status)).toEqual([
      "Syncs now; work is running, so Codex is not restarted",
      "Skipped: not linked to this Home; repair it in Settings → Hub",
      "Skipped: work is running there; try again when it finishes",
    ]);
  });

  it("keeps Sync off with the reason a person can act on", () => {
    const base = { allowed: true, reading: false, running: false, planError: null, plan };
    expect(syncAction(base)).toEqual({ enabled: true, reason: null });
    expect(syncAction({ ...base, allowed: false }).reason).toBe(
      "Syncing needs permission to maintain this server.",
    );
    expect(syncAction({ ...base, planError: "Could not reach this server's machines." })).toEqual({
      enabled: false,
      reason: "Could not reach this server's machines.",
    });
    const nothing = { ...plan, members: plan.members.slice(1) };
    expect(syncAction({ ...base, plan: nothing }).reason).toBe("No machine can sync right now.");
  });

  it("follows the live report only once this dialog's own sync started", () => {
    const earlier: OpenCodexSyncReport = { ...plan, trigger: "manual", checkedAt: 5 };
    const current: OpenCodexSyncReport = { ...earlier, checkedAt: 9 };
    expect(shownReport({ plan, live: earlier, result: null, before: undefined })).toBe(plan);
    expect(shownReport({ plan, live: earlier, result: null, before: 5 })).toBe(plan);
    expect(shownReport({ plan, live: current, result: null, before: 5 })).toBe(current);
    expect(shownReport({ plan, live: null, result: current, before: 5 })).toBe(current);
  });

  it("lists every machine whose post-update sync failed or was skipped", () => {
    expect(
      openCodexSyncNotes({
        trigger: "update",
        checkedAt: 0,
        targetVersion: "2.91.0",
        members: [
          { alias: null, state: "synced", restartCodex: true },
          { alias: "mac-studio", state: "failed", restartCodex: true, reason: "exit-2" },
          { alias: "mini", state: "skipped", restartCodex: false, reason: "busy" },
        ],
      }),
    ).toEqual([
      "OpenCodex sync on mac-studio failed: ocx sync exited 2.",
      "OpenCodex sync on mini skipped: work is running there; try again when it finishes.",
    ]);
    expect(openCodexSyncNotes({ ...plan, trigger: "manual" })).toEqual([]);
  });
});
