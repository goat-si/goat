import { expect, it } from "@effect/vitest";

import { type AgentSurfaceEntry, agentSurfaceRegistry } from "./registry.ts";
import { isDeduplicatedCall, isKeyedWrite } from "./resolve.ts";

type Entry = AgentSurfaceEntry & { readonly path: string };
const entries: ReadonlyArray<Entry> = Object.values(agentSurfaceRegistry);
const byPath: ReadonlyMap<string, Entry> = new Map(entries.map((entry) => [entry.path, entry]));

// Writes that still take no retry key and record no reason. Remove a path when its write
// declares one; this list only shrinks.
const NOT_YET_KEYED: ReadonlySet<string> = new Set<string>([]);

it("requires keys only on ToolAdmission-keyed writes", () => {
  const required = entries.filter((entry) => entry.keyRequired);
  expect(required.map((entry) => entry.path).sort()).toEqual([
    "memory.binding_update",
    "memory.hub_reconcile",
    "memory.report_attempts_reset",
    "pull_request.comment",
    "pull_request.review_submit",
    "pull_request.thread_reply",
    "terminal.clear",
    "terminal.close",
    "terminal.open",
    "terminal.restart",
    "terminal.write",
    "workspace.write",
  ]);
  for (const entry of required) {
    expect(entry.idempotency, entry.path).toBe("key");
    expect(isKeyedWrite(entry), entry.path).toBe(true);
  }
});

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

it("gives every write deduplicated in its own store a reason, and keeps it off ToolAdmission", () => {
  for (const entry of entries) {
    if (entry.idempotency !== "domain") {
      expect(entry.keyIgnoredWith, entry.path).toBeUndefined();
      continue;
    }
    expect(entry.effect, entry.path).not.toBe("read");
    expect(entry.idempotencyReason?.trim(), entry.path).toBeTruthy();
    expect(entry.reconcile, entry.path).toBeUndefined();
    expect(isKeyedWrite(entry), entry.path).toBe(false);
  }
});

it("deduplicates a keyed call only when no argument that bypasses its store is set", () => {
  const call = (path: string, args: Readonly<Record<string, unknown>>) => {
    const entry = byPath.get(path);
    expect(entry, path).toBeDefined();
    return isDeduplicatedCall(entry!, args);
  };
  const key = { clientRequestId: "k" };
  for (const stopCascade of [undefined, null, false])
    expect(call("thread.interrupt", { ...key, stopCascade }), String(stopCascade)).toBe(true);
  expect(call("thread.interrupt", { ...key, stopCascade: true })).toBe(false);
  for (const path of ["thread.send", "thread.retry", "thread.interrupt"])
    expect(call(path, { ...key, host: "mac-mini" }), path).toBe(false);
  expect(call("goal.apply", { ...key, id: null })).toBe(true);
  expect(call("goal.apply", { ...key, id: "goal-1" })).toBe(false);
  expect(call("goal.apply", {})).toBe(false);
  // A repeat upserts the schedule row or re-reads the child's tasks; the key does not hold.
  for (const path of ["schedule.create", "task.cancel"]) expect(call(path, key), path).toBe(false);
});
