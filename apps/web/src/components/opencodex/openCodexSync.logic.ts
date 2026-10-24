import type { OpenCodexSyncMember, OpenCodexSyncReport } from "@goat/contracts";

export type SyncTone = "muted" | "progress" | "success" | "warning" | "destructive";

export interface SyncRowView {
  readonly key: string;
  readonly label: string;
  readonly status: string;
  readonly tone: SyncTone;
}

const REASON_TEXT: Readonly<Record<string, string>> = {
  busy: "work is running there; try again when it finishes",
  "not-connected": "not linked to this Home; repair it in Settings → Hub",
  "not-permitted": "outside the hosts this caller may reach",
  unreachable: "did not answer",
  "not-installed": "OpenCodex is not installed",
  updating: "OpenCodex is updating; each machine syncs right after its update",
  "connection-changed": "its link changed during the sync",
  "timed-out": "timed out",
};

export function syncReasonText(reason: string | undefined): string {
  if (reason === undefined) return "no reason given";
  const exit = /^exit-(\d+)$/u.exec(reason);
  return exit ? `ocx sync exited ${exit[1]}` : (REASON_TEXT[reason] ?? reason);
}

/** One machine's line: what will happen, what is happening, or what happened. */
export function syncRowView(member: OpenCodexSyncMember, homeLabel: string): SyncRowView {
  const label = member.alias ?? homeLabel;
  const key = member.alias ?? "";
  switch (member.state) {
    case "ready":
      return {
        key,
        label,
        tone: "muted",
        status:
          member.reason === "reconnect"
            ? "Reconnects its link, then syncs and restarts Codex"
            : member.restartCodex
              ? "Syncs and restarts Codex"
              : "Syncs now; Codex restarts once its work finishes",
      };
    case "syncing":
      return { key, label, tone: "progress", status: "Syncing…" };
    case "synced":
      return member.reason === "stale"
        ? {
            key,
            label,
            tone: "warning",
            status: "Synced from its last catalog; the Home did not answer",
          }
        : {
            key,
            label,
            tone: "success",
            status: member.restartCodex
              ? "Synced · Codex restarted"
              : "Synced · Codex restarts once its work finishes",
          };
    case "failed":
      return {
        key,
        label,
        tone: "destructive",
        status: `Failed: ${syncReasonText(member.reason)}`,
      };
    case "skipped":
      return { key, label, tone: "warning", status: `Skipped: ${syncReasonText(member.reason)}` };
  }
}

/** Whether Sync can start now, and why not when it cannot. */
export function syncAction(input: {
  readonly allowed: boolean;
  readonly reading: boolean;
  readonly running: boolean;
  readonly planError: string | null;
  readonly plan: OpenCodexSyncReport | null;
}): { readonly enabled: boolean; readonly reason: string | null } {
  const blocked = (reason: string) => ({ enabled: false, reason });
  if (!input.allowed) return blocked("Syncing needs permission to maintain this server.");
  if (input.running) return blocked("Syncing…");
  if (input.reading) return blocked("Checking each machine…");
  if (input.planError !== null) return blocked(input.planError);
  if (input.plan === null || !input.plan.members.some(({ state }) => state === "ready"))
    return blocked("No machine can sync right now.");
  return { enabled: true, reason: null };
}

/**
 * The live report once this dialog's own run has started, so every machine shows its progress;
 * before that, the plan. `before` is the live report's time when Sync was pressed.
 */
export function shownReport(input: {
  readonly plan: OpenCodexSyncReport | null;
  readonly live: OpenCodexSyncReport | null;
  readonly result: OpenCodexSyncReport | null;
  readonly before: number | null | undefined;
}): OpenCodexSyncReport | null {
  if (input.result !== null) return input.result;
  const live = input.live;
  if (input.before !== undefined && live?.trigger === "manual" && live.checkedAt !== input.before)
    return live;
  return input.plan;
}

/** Lines for the update result: each machine whose post-update sync did not finish cleanly. */
export function openCodexSyncNotes(report: OpenCodexSyncReport | undefined): ReadonlyArray<string> {
  if (report === undefined || report.trigger !== "update") return [];
  return report.members.flatMap((member) =>
    member.state === "failed" || member.state === "skipped"
      ? [
          `OpenCodex sync on ${member.alias ?? "this Mac"} ${member.state}: ${syncReasonText(member.reason)}.`,
        ]
      : [],
  );
}
