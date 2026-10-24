import { expect, it } from "@effect/vitest";

import { type AgentSurfaceEntry, agentSurfaceRegistry } from "./registry.ts";

type Entry = AgentSurfaceEntry & { readonly path: string };
const entries: ReadonlyArray<Entry> = Object.values(agentSurfaceRegistry);
const byPath: ReadonlyMap<string, Entry> = new Map(entries.map((entry) => [entry.path, entry]));

// Writes that still take no retry key and record no reason (#1029). Remove a path when its write
// declares one; this list only shrinks.
const NOT_YET_KEYED: ReadonlySet<string> = new Set([
  "attachment.discard",
  "attachment.prepare_upload",
  "channel.bot_home_claim",
  "channel.task_move",
  "channel.task_report",
  "cloud_agent.launch",
  "cloud_agent.run_forget",
  "cloud_agent.run_register",
  "cloud_machine.create",
  "cloud_machine.resume",
  "cloud_machine.stop",
  "computer_use.request",
  "connection.add_ssh",
  "connection.remove",
  "decision.answer",
  "decision.request",
  "device.close",
  "device.open",
  "environment.preferences_update",
  "fallback_chain.set",
  "goal.delete",
  "goal.pause",
  "goal.resume",
  "host.cordon",
  "host.drain",
  "host.uncordon",
  "host_link.create",
  "host_link.remove",
  "html.render",
  "hub.device_join",
  "hub.device_leave",
  "hub.device_repair",
  "memory.forget",
  "memory.hub_disable",
  "memory.revert_resolution",
  "memory.settings_update",
  "memory.upsert",
  "note.move",
  "note.update",
  "note.write",
  "operation.cancel",
  "origin.report",
  "origin.report_wait",
  "pending_request.respond",
  "permission_profile.sync",
  "preview.back",
  "preview.click",
  "preview.close",
  "preview.dialog",
  "preview.drag",
  "preview.evaluate",
  "preview.forward",
  "preview.hover",
  "preview.navigate",
  "preview.open",
  "preview.press",
  "preview.recording_start",
  "preview.recording_stop",
  "preview.reload",
  "preview.resize",
  "preview.scroll",
  "preview.select",
  "preview.set_appearance",
  "preview.type",
  "preview.upload",
  "project.clone",
  "project.create",
  "project.update",
  "provider.home_request",
  "provider.login_cancel",
  "provider.login_start",
  "provider.setup_open",
  "provider.sync",
  "provider.sync_cancel",
  "pull_request.link",
  "pull_request.unlink",
  "pull_request.unwatch",
  "pull_request.watch",
  "pull_request_guide.update",
  "queue.cancel",
  "queue.edit",
  "queue.promote_to_steer",
  "queue.reorder",
  "schedule.delete",
  "schedule.run",
  "schedule.update",
  "ssh.browse",
  "ssh.host_add",
  "ssh.host_forget",
  "ssh.host_prepare",
  "ssh.runtime_update",
  "ssh.thread_handoff",
  "surface.call",
  "task.read",
  "thread.checkpoint_capture",
  "thread.checkpoint_reconcile",
  "thread.checkpoint_restore",
  "thread.configure",
  "thread.fork",
  "thread.handoff_host",
  "thread.merge_back",
  "thread.organize",
  "thread.replication_set",
  "thread.report_result",
  "thread.reschedule",
  "thread.send_attachments",
  "thread.unwatch",
  "thread.watch",
  "workflow.stop",
  "worktree.cleanup",
  "worktree.handoff",
]);

it("gives every write a retry key with a reconcile read, or a recorded reason it has none", () => {
  for (const entry of entries) {
    if (entry.effect === "read") {
      expect(entry.idempotency, entry.path).toBeUndefined();
      expect(entry.idempotencyReason, entry.path).toBeUndefined();
      continue;
    }
    if (entry.idempotency === "key") {
      const reconcile = entry.reconcile === undefined ? undefined : byPath.get(entry.reconcile);
      expect(reconcile?.effect, `${entry.path} reconciles with a registered read`).toBe("read");
      // ToolAdmission names the reconcile read with the write's host; a local-only read there
      // would report on the wrong machine and invite a duplicate.
      if (entry.hostRoutable)
        expect(reconcile?.hostRoutable, `${entry.path} reconciles on its host`).toBe(true);
      expect(NOT_YET_KEYED.has(entry.path), entry.path).toBe(false);
    } else if (entry.idempotencyReason !== undefined) {
      expect(entry.idempotencyReason.trim(), entry.path).not.toBe("");
      expect(NOT_YET_KEYED.has(entry.path), entry.path).toBe(false);
    } else {
      expect(NOT_YET_KEYED.has(entry.path), `${entry.path} needs a key or a reason`).toBe(true);
    }
  }
});

it("allowlists only registered writes that still lack a key and a reason", () => {
  for (const path of NOT_YET_KEYED) {
    const entry = byPath.get(path);
    expect(entry?.effect, path).not.toBe("read");
    expect(entry?.idempotency ?? entry?.idempotencyReason, path).toBeUndefined();
  }
});
