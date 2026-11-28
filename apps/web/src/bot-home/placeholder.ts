// Placeholder data mirroring the Paper SSOT (봇 홈 — SSOT). Replace with server data.
export type BotStatus = "idle" | "working" | "needs-you" | "done";

export interface BotRow {
  id: string;
  name: string;
  driver: string;
  status: BotStatus;
  lastLine: string;
  when: string;
  color: string;
}

export const bots: BotRow[] = [
  { id: "main", name: "GOAT", driver: "claudeAgent", status: "idle", lastLine: "2 decisions are waiting. Everything else is running.", when: "3:41 PM", color: "#111113" },
  { id: "reviewer", name: "Reviewer", driver: "codex", status: "needs-you", lastLine: "PR #7712 reviewed. Decide whether to merge.", when: "Needs you", color: "#FF8A1F" },
  { id: "ci", name: "CI Watch", driver: "claudeAgent", status: "working", lastLine: "Fixing 2 red checks on main. 3/5 tests pass.", when: "Working", color: "#9C6B3E" },
  { id: "browser", name: "Browser Hand", driver: "antigravity", status: "needs-you", lastLine: "Needs a Luma login code. Check your phone.", when: "Needs you", color: "#2FB36B" },
  { id: "standup", name: "Standup", driver: "pi", status: "idle", lastLine: "Posted Mapo and Gangnam threads. Next run 07:00.", when: "Yesterday", color: "#B9B9C0" },
  { id: "release", name: "Release Notes", driver: "opencode", status: "working", lastLine: "Drafting v2.93.0. Features first, fixes below.", when: "Working", color: "#3D5AFE" },
];

export const selectedRuntime = {
  cli: "Codex CLI 0.142.0",
  model: "gpt-6.1-sol · high",
  machine: "Wicked server · local",
  account: "ChatGPT Pro · you@example.com",
  permissions: "Full access",
  workspace: "opencodex · codex/pr-7712",
};

/** What a bot runs on. The picker writes this; every surface reads it. */
export interface BotRuntime {
  driver: string;
  model: string;
  effort: string;
  machine: string;
  account: string;
  permissions: string;
  workspace: string;
}

/** Placeholder provider catalog. Real data: ServerProvider list (driver, displayName, installedVersion, models). */
export const catalog: Array<{ driver: string; label: string; version: string; models: string[] }> = [
  { driver: "codex", label: "Codex CLI", version: "0.142.0", models: ["gpt-6.1-sol", "gpt-6-luna"] },
  { driver: "claudeAgent", label: "Claude Code", version: "2.4.1", models: ["claude-opus-5-5", "claude-sonnet-5"] },
  { driver: "antigravity", label: "Antigravity", version: "2.33.0", models: ["gemini-4", "gemini-4-flash"] },
  { driver: "opencode", label: "OpenCode", version: "1.6.2", models: ["grok-5", "kimi-k3.1"] },
  { driver: "pi", label: "Pi", version: "0.9.4", models: ["kimi-k3.1", "qwen-4"] },
];

export const initialRuntimes: Record<string, BotRuntime> = Object.fromEntries(
  bots.map((b) => {
    const c = catalog.find((x) => x.driver === b.driver) ?? catalog[0]!;
    return [b.id, {
      driver: c.driver, model: c.models[0]!, effort: "high",
      machine: b.driver === "codex" || b.driver === "pi" ? "Wicked · local" : "M5 Max · local",
      account: "",
      permissions: "Full access", workspace: "opencodex · codex/pr-7712",
    }];
  }),
);

/** Placeholder: the signed-in account per CLI. Real data: ServerProviderAuth.label + masked email. */
export const accountFor: Record<string, string> = {
  codex: "ChatGPT Pro · you@example.com",
  claudeAgent: "Claude Max · you@example.com",
  antigravity: "Google AI Ultra · you@example.com",
  opencode: "OpenCodex · local",
  pi: "Kimi · you@example.com",
};

for (const r of Object.values(initialRuntimes)) r.account = accountFor[r.driver] ?? "";
