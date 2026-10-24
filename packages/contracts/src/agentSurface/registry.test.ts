import { describe, expect, it } from "@effect/vitest";
import { type AgentSurfaceEntry, agentSurfaceRegistry } from "./registry.ts";
import {
  deprecatedReplacement,
  isKeyedWrite,
  legacyAgentSurfacePaths,
  legacyToolNameTargets,
  listedToolName,
  resolveAgentSurfaceEntry,
} from "./resolve.ts";

type Entry = (typeof agentSurfaceRegistry)[keyof typeof agentSurfaceRegistry];
const entries: ReadonlyArray<Entry> = Object.values(agentSurfaceRegistry);

// The projections in docs/internals/agent-surface.md#paths. Resource and verb are stored
// separately because names such as goat_preview_recording_start cannot be split reliably.
const mcpName = (entry: AgentSurfaceEntry) => `goat_${entry.resource}_${entry.verb}`;
const kebab = (part: string) => part.replaceAll("_", "-");
const cliCommand = (entry: AgentSurfaceEntry) =>
  `goat ${kebab(entry.resource)} ${kebab(entry.verb)}`;

// Shipped names that are not the projection of their path. Since the listing flip they stay
// callable without being listed (docs/internals/agent-surface.md#rollout, step 10; #781).
const OFF_GRAMMAR_NAMES = [
  "channel_bot_home",
  "channel_bot_home_claim",
  "channel_ingest",
  "channel_input_get",
  "channel_task_export",
  "channel_task_get",
  "channel_task_list",
  "channel_task_move",
  "channel_task_report",
  "create_threads",
  "delegate_task",
  "delete_scheduled_task",
  "device_close",
  "device_list",
  "device_open",
  "device_screenshot",
  "goat_cloud_holders",
  "goat_cloud_launch",
  "goat_cloud_run_forget",
  "goat_cloud_run_list",
  "goat_cloud_run_register",
  "goat_decision_get",
  "goat_goatclaw_sync",
  "goat_origin_reports_wait",
  "goat_permission_profile_get",
  "goat_provider_sync_status",
  "goat_thread_configuration",
  "html_preview",
  "html_render",
  "link_pull_request",
  "list_scheduled_tasks",
  "list_thread_pull_requests",
  "memory_forget",
  "memory_history",
  "memory_hub_disable",
  "memory_list",
  "memory_read",
  "memory_read_source",
  "memory_revert_resolution",
  "memory_search",
  "memory_settings_get",
  "memory_settings_update",
  "memory_sync_status",
  "memory_upsert",
  "orchestrator_capabilities",
  "preview_back",
  "preview_click",
  "preview_dialog",
  "preview_drag",
  "preview_evaluate",
  "preview_forward",
  "preview_hover",
  "preview_logs",
  "preview_navigate",
  "preview_open",
  "preview_press",
  "preview_recording_start",
  "preview_recording_stop",
  "preview_reload",
  "preview_resize",
  "preview_scroll",
  "preview_select",
  "preview_set_appearance",
  "preview_snapshot",
  "preview_status",
  "preview_type",
  "preview_upload",
  "preview_wait_for",
  "read_pull_request_guide",
  "request_secret",
  "run_scheduled_task_now",
  "schedule_task",
  "task_cancel",
  "task_status",
  "unlink_pull_request",
  "unwatch_pull_request",
  "update_scheduled_task",
  "watch_pull_request",
  "write_pull_request_guides",
] as const;

// The two meta tools keep the short names the design gives them (agent-surface.md, Discovery and
// Calling); they are how an agent reaches every path, so they are not themselves a resource.
const META_TOOL_NAMES = ["goat_describe", "goat_call"] as const;

describe("agent surface grammar", () => {
  it("keeps paths, resources and verbs in lower snake case", () => {
    for (const [key, entry] of Object.entries(agentSurfaceRegistry)) {
      expect(key).toBe(`${entry.resource}.${entry.verb}`);
      expect(entry.resource, key).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
      expect(entry.verb, key).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
    }
  });

  it("projects every path to a distinct MCP name and CLI command", () => {
    for (const project of [mcpName, cliCommand]) {
      const projected = entries.map(project);
      expect(new Set(projected).size).toBe(entries.length);
    }
  });

  it("names every new tool by its path", () => {
    const listed = new Set<string>([...OFF_GRAMMAR_NAMES, ...META_TOOL_NAMES]);
    const offGrammar = entries.filter((entry) => entry.name !== mcpName(entry));
    expect(
      offGrammar.filter((entry) => !listed.has(entry.name)).map((entry) => entry.path),
    ).toEqual([]);
  });

  it("keeps every shipped name resolvable as exactly one entry's legacy name", () => {
    for (const legacy of OFF_GRAMMAR_NAMES) {
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

  it("routes exactly the off-grammar names to their canonical names, shadowing no listed name", () => {
    const listed = new Set<string>(entries.map(listedToolName));
    for (const legacy of OFF_GRAMMAR_NAMES) {
      const owner = entries.find((entry) => entry.legacyNames.includes(legacy))!;
      expect(legacyToolNameTargets.get(legacy), legacy).toBe(mcpName(owner));
      expect(deprecatedReplacement(legacy), legacy).toBe(mcpName(owner));
    }
    expect(legacyToolNameTargets.size).toBe(OFF_GRAMMAR_NAMES.length);
    for (const legacy of legacyToolNameTargets.keys())
      expect(listed.has(legacy), legacy).toBe(false);
    for (const entry of entries)
      expect(deprecatedReplacement(listedToolName(entry))).toBeUndefined();
  });

  it("lists the meta tools under their short names and every other path by its projection", () => {
    for (const entry of entries)
      expect(listedToolName(entry), entry.path).toBe(
        entry.resource === "surface" ? entry.name : mcpName(entry),
      );
    expect(agentSurfaceRegistry["surface.call"].legacyNames).toEqual([]);
  });

  it("keeps every renamed path resolvable to the entry that replaced it", () => {
    for (const [legacy, path] of legacyAgentSurfacePaths) {
      expect(resolveAgentSurfaceEntry(legacy)?.path, legacy).toBe(path);
      expect(deprecatedReplacement(legacy), legacy).toBe(path);
      expect(Object.hasOwn(agentSurfaceRegistry, legacy), legacy).toBe(false);
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

  it("names a read that settles the unknown outcome of every keyed write", () => {
    const reconcileOf = (entry: AgentSurfaceEntry) => entry.reconcile;
    for (const entry of entries.filter((candidate) => isKeyedWrite(candidate))) {
      expect(entry.effect, entry.path).not.toBe("read");
      const read = resolveAgentSurfaceEntry(reconcileOf(entry) ?? "");
      expect(read?.effect, entry.path).toBe("read");
      const threadRead =
        (entry.resource === "ssh" && entry.verb.startsWith("thread_")) ||
        entry.path === "cloud_agent.launch" ||
        entry.path === "origin.report";
      expect(read?.resource, entry.path).toBe(threadRead ? "thread" : entry.resource);
      // A write routed to another host is settled by reading that host.
      if (entry.hostRoutable) expect(read?.hostRoutable, entry.path).toBe(true);
    }
  });
});
