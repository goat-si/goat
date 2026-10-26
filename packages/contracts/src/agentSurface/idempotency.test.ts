import { expect, it } from "@effect/vitest";

import { type AgentSurfaceEntry, agentSurfaceRegistry } from "./registry.ts";

type Entry = AgentSurfaceEntry & { readonly path: string };
const entries: ReadonlyArray<Entry> = Object.values(agentSurfaceRegistry);
const byPath: ReadonlyMap<string, Entry> = new Map(entries.map((entry) => [entry.path, entry]));

// Writes that still take no retry key and record no reason (#1029). Remove a path when its write
// declares one; this list only shrinks.
const NOT_YET_KEYED: ReadonlySet<string> = new Set<string>([]);

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
