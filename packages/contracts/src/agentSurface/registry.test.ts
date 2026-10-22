import { describe, expect, it } from "@effect/vitest";
import { type AgentSurfaceEntry, agentSurfaceRegistry } from "./registry.ts";

type Entry = (typeof agentSurfaceRegistry)[keyof typeof agentSurfaceRegistry];
const entries: ReadonlyArray<Entry> = Object.values(agentSurfaceRegistry);

// The three projections in docs/internals/agent-surface.md#paths. Resource and verb are stored
// separately because names such as goat_preview_recording_start cannot be split reliably.
const mcpName = (entry: AgentSurfaceEntry) => `goat_${entry.resource}_${entry.verb}`;
const kebab = (part: string) => part.replaceAll("_", "-");
const cliCommand = (entry: AgentSurfaceEntry) =>
  `goat ${kebab(entry.resource)} ${kebab(entry.verb)}`;
const docsAnchor = (entry: AgentSurfaceEntry) =>
  `reference/${kebab(entry.resource)}.md#${kebab(entry.verb)}`;

// The naming map in docs/internals/agent-surface.md#naming-map: 48 legacy names whose canonical
// name is the projection of their path. They must stay resolvable through the deprecation window,
// so each one stays in exactly one entry's legacyNames before and after the listing flip.
const DESIGN_RENAMES = [
  "create_threads",
  "delegate_task",
  "task_status",
  "task_cancel",
  "orchestrator_capabilities",
  "schedule_task",
  "list_scheduled_tasks",
  "update_scheduled_task",
  "delete_scheduled_task",
  "run_scheduled_task_now",
  "request_secret",
  "preview_status",
  "preview_open",
  "preview_dialog",
  "preview_navigate",
  "preview_resize",
  "preview_set_appearance",
  "preview_snapshot",
  "preview_click",
  "preview_type",
  "preview_hover",
  "preview_select",
  "preview_drag",
  "preview_upload",
  "preview_press",
  "preview_scroll",
  "preview_evaluate",
  "preview_wait_for",
  "preview_recording_start",
  "preview_recording_stop",
  "device_list",
  "device_open",
  "device_screenshot",
  "device_close",
  "html_preview",
  "html_render",
  "link_pull_request",
  "unlink_pull_request",
  "list_thread_pull_requests",
  "watch_pull_request",
  "unwatch_pull_request",
  "write_pull_request_guides",
  "read_pull_request_guide",
  "channel_ingest",
  "channel_input_get",
  "channel_task_get",
  "channel_task_list",
  "channel_task_report",
] as const;

// Tools added after the naming map, or kept "unchanged" by it although their name is not the
// projection of their path. Each needs a canonical-name decision before the listing flip (#781).
const UNMAPPED_NAMES = [
  "goat_goatclaw_sync",
  "goat_cloud_holders",
  "goat_cloud_launch",
  "goat_cloud_run_register",
  "goat_cloud_run_list",
  "goat_cloud_run_forget",
  "channel_bot_home",
  "channel_bot_home_claim",
  "channel_task_export",
  "channel_task_move",
  "preview_back",
  "preview_forward",
  "preview_reload",
  "preview_logs",
  "memory_search",
  "memory_list",
  "memory_read",
  "memory_history",
  "memory_sync_status",
  "memory_upsert",
  "memory_forget",
  "memory_revert_resolution",
  "memory_read_source",
  "memory_hub_disable",
  "memory_settings_get",
  "memory_settings_update",
] as const;

describe("agent surface grammar", () => {
  it("keeps paths, resources and verbs in lower snake case", () => {
    for (const [key, entry] of Object.entries(agentSurfaceRegistry)) {
      expect(key).toBe(`${entry.resource}.${entry.verb}`);
      expect(entry.resource, key).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
      expect(entry.verb, key).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
    }
  });

  it("projects every path to a distinct MCP name, CLI command and docs anchor", () => {
    for (const project of [mcpName, cliCommand, docsAnchor]) {
      const projected = entries.map(project);
      expect(new Set(projected).size).toBe(entries.length);
    }
  });

  it("names every new tool by its path; older names are listed with a pending decision", () => {
    const pending = new Set<string>([...DESIGN_RENAMES, ...UNMAPPED_NAMES]);
    const offGrammar = entries.filter((entry) => entry.name !== mcpName(entry));
    expect(
      offGrammar.filter((entry) => !pending.has(entry.name)).map((entry) => entry.path),
    ).toEqual([]);
    // A name that was renamed leaves this list; the alias test below keeps it resolvable.
    const known = new Set(entries.flatMap((entry) => entry.legacyNames));
    expect(UNMAPPED_NAMES.filter((name) => !known.has(name))).toEqual([]);
  });

  it("keeps each design rename resolvable as exactly one entry's legacy name", () => {
    for (const legacy of DESIGN_RENAMES) {
      const owners = entries.filter((entry) => entry.legacyNames.includes(legacy));
      expect(
        owners.map((entry) => entry.path),
        legacy,
      ).toHaveLength(1);
      const [owner] = owners;
      // Before the flip the entry still answers to its legacy name; after it, only the projection.
      expect([legacy, mcpName(owner!)], owner!.path).toContain(owner!.name);
    }
  });

  it("never lets a legacy name shadow another entry", () => {
    const owner = new Map<string, string>();
    for (const entry of entries) {
      for (const name of new Set([entry.name, mcpName(entry), ...entry.legacyNames])) {
        expect(owner.get(name) ?? entry.path, name).toBe(entry.path);
        owner.set(name, entry.path);
      }
    }
  });
});

describe("agent surface metadata", () => {
  it("gives every entry a one-line summary short enough for lists and --help", () => {
    const tooLong = entries.filter(
      (entry) =>
        entry.summary.trim() !== entry.summary ||
        entry.summary.length === 0 ||
        entry.summary.includes("\n") ||
        entry.summary.length > 160,
    );
    expect(tooLong.map((entry) => entry.path)).toEqual([]);
    for (const entry of entries) expect(entry.description.length, entry.path).toBeGreaterThan(0);
  });

  it("offers dryRun only where a write can plan", () => {
    for (const entry of entries)
      if (entry.dryRun === "supported") expect(entry.effect, entry.path).not.toBe("read");
  });

  it("keeps every example inside the envelope it documents", () => {
    for (const entry of entries)
      for (const example of entry.examples) {
        expect(example.title.trim(), entry.path).not.toBe("");
        expect(["ok", "error", "needs_human"], entry.path).toContain(example.expect["status"]);
      }
  });
});
