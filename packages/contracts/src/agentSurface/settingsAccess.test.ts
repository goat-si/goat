import { describe, expect, it } from "@effect/vitest";
import { requiredScopesForServerSettingsPatch, ServerSettingsPatch } from "../settings.ts";
import { type AgentSurfaceEntry, agentSurfaceRegistry } from "./registry.ts";
import { SETTINGS_ACCESS, SETTINGS_WRITE_EXCEPTIONS, type SettingsKey } from "./settingsAccess.ts";

const keys = Object.keys(SETTINGS_ACCESS) as ReadonlyArray<SettingsKey>;
const entries: ReadonlyArray<AgentSurfaceEntry & { readonly path: string }> =
  Object.values(agentSurfaceRegistry);
const entryAt = (path: string) => entries.find((entry) => entry.path === path);

/** Whether a schema carries a credential anywhere inside it (settingsSecret or a password field). */
function holdsSecret(root: unknown): boolean {
  const seen = new Set<unknown>();
  const walk = (node: unknown): boolean => {
    if (node === null || typeof node !== "object" || seen.has(node)) return false;
    seen.add(node);
    const annotations = (node as { readonly annotations?: Record<string, unknown> }).annotations;
    if (
      annotations?.settingsSecret === true ||
      (annotations?.providerSettingsForm as { readonly control?: string } | undefined)?.control ===
        "password"
    )
      return true;
    return Object.values(node).some(walk);
  };
  return walk(root);
}

// The rule in AGENTS.md and docs/internals/agent-surface.md#settings: a setting reaches agents by
// being classified here, never through a tool of its own.
describe("settings access", () => {
  it("classifies every server setting exactly once", () => {
    expect([...keys].sort()).toEqual(Object.keys(ServerSettingsPatch.fields).sort());
  });

  it("never lets agents change or read a setting that holds a credential", () => {
    const secretKeys = keys.filter((key) => holdsSecret(ServerSettingsPatch.fields[key].ast));
    expect(secretKeys.length).toBeGreaterThan(0);
    for (const key of secretKeys) expect(SETTINGS_ACCESS[key].access, key).not.toBe("agent");
  });

  it("needs no grant beyond settings:write for any agent setting", () => {
    for (const key of keys.filter((key) => SETTINGS_ACCESS[key].access === "agent"))
      expect(
        requiredScopesForServerSettingsPatch({ [key]: true } as ServerSettingsPatch),
        key,
      ).toEqual(["settings:write"]);
  });

  it("routes owned settings to registered write paths", () => {
    for (const key of keys) {
      const rule = SETTINGS_ACCESS[key];
      if (rule.access !== "path") continue;
      expect(entryAt(rule.path)?.effect, `${key} -> ${rule.path}`).toMatch(/^(write|destructive)$/);
    }
  });

  it("adds no settings.write path without a reviewed reason", () => {
    const writers = entries
      .filter((entry) => entry.capability === "settings.write")
      .map((entry) => entry.path)
      .sort();
    expect(writers).toEqual(
      ["environment.settings_update", ...Object.keys(SETTINGS_WRITE_EXCEPTIONS)].sort(),
    );
  });

  it("keeps every settings path out of the core listing", () => {
    const paths = new Set<string>([
      "environment.settings_read",
      "environment.settings_update",
      ...Object.keys(SETTINGS_WRITE_EXCEPTIONS),
      ...keys.flatMap((key) => {
        const rule = SETTINGS_ACCESS[key];
        return rule.access === "path" ? [rule.path] : [];
      }),
    ]);
    for (const path of paths) expect(entryAt(path)?.listing, path).toBeUndefined();
  });
});
