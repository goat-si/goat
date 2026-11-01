// @effect-diagnostics nodeBuiltinImport:off -- synthetic temporary settings fixture only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  IMESSAGE_SETTINGS_FILE,
  loadImessageSettings,
  normalizeHandle,
  validateImessageSettings,
  type ImessageSettingsFile,
} from "./ImessageChannelSettings.ts";

const file: ImessageSettingsFile = {
  version: 1,
  enabled: true,
  connectionId: "imessage-000000000001",
  allowedHandles: ["+15550000000"],
  ownHandles: ["+15550000001"],
  owner: {
    ownerId: "owner",
    principalId: "local-cli",
    displayName: "Owner",
    grantedScopes: ["orchestration:operate"],
    runtimeModeCeiling: "approval-required",
  },
};

describe("iMessage settings", () => {
  it("normalizes and rejects ambiguous allowlists", () => {
    expect(normalizeHandle(" Person@Example.com ")).toBe("person@example.com");
    expect(normalizeHandle("12345")).toBeUndefined();
    expect(validateImessageSettings(file)?.connectionId).toBe(file.connectionId);
    expect(validateImessageSettings({ ...file, allowedHandles: [] })).toBeUndefined();
    expect(
      validateImessageSettings({ ...file, allowedHandles: ["+15550000000", "+15550000000"] }),
    ).toBeUndefined();
    expect(validateImessageSettings({ ...file, ownHandles: ["+15550000000"] })).toBeUndefined();
    expect(
      validateImessageSettings({ ...file, owner: { ...file.owner, grantedScopes: [] } }),
    ).toBeUndefined();
  });
  it.effect("loads only enabled Mac settings without writing files", () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-imsg-settings-"));
      try {
        expect(yield* loadImessageSettings({ stateDir: dir, platform: "darwin" })).toBeUndefined();
        NodeFS.writeFileSync(NodePath.join(dir, IMESSAGE_SETTINGS_FILE), JSON.stringify(file));
        expect(
          (yield* loadImessageSettings({ stateDir: dir, platform: "darwin" }))?.connectionId,
        ).toBe(file.connectionId);
        expect(yield* loadImessageSettings({ stateDir: dir, platform: "linux" })).toBeUndefined();
        NodeFS.writeFileSync(
          NodePath.join(dir, IMESSAGE_SETTINGS_FILE),
          JSON.stringify({ ...file, version: 2 }),
        );
        expect(yield* loadImessageSettings({ stateDir: dir, platform: "darwin" })).toBeUndefined();
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }),
  );
});
