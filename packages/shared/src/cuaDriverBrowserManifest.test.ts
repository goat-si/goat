import { describe, expect, it } from "vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Manifest from "./cuaDriverManifest.ts";

const union = {
  existingProfiles: [
    { pid: 12, windowId: 34 },
    { pid: 56, windowId: 78 },
  ],
  origins: ["https://example.test"],
};
const empty = { existingProfiles: [], origins: [] };

describe("browser claim manifest publication", () => {
  it("admits only exact pairs and preserves other manifest content", () => {
    const original = Manifest.cuaDriverCapabilityManifest({
      applications: ["editor"],
      tools: ["click", "type_text"],
    });
    const result = Manifest.updateCuaDriverBrowserManifest(original, union);
    expect(result).toContain(
      "      - pid: 12\n        window_id: 34\n      - pid: 56\n        window_id: 78",
    );
    expect(result).toContain('      - "https://example.test"');
    expect(result).not.toContain("kind: existing_profile");
    expect(result).not.toContain("    profiles:");
    expect(result).toContain('    - "browser_click"');
    expect(Manifest.updateCuaDriverBrowserManifest(result, empty)).toBe(original);
  });

  it("removes browser resources and claim tools when the union is empty", () => {
    const original = Manifest.cuaDriverCapabilityManifest({ applications: ["editor"] });
    const result = Manifest.updateCuaDriverBrowserManifest(
      Manifest.updateCuaDriverBrowserManifest(original, union),
      empty,
    );
    expect(result).toBe(original);
    expect(result).not.toContain("  browser:");
    expect(result).not.toContain('    - "browser_click"');
  });

  it("atomically replaces the file and returns the hash of its exact bytes", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-browser-manifest-"));
    try {
      const path = NodePath.join(dir, "manifest.yaml");
      const original = Manifest.cuaDriverCapabilityManifest({ applications: ["editor"] });
      await NodeFSP.writeFile(path, original);
      const operations: string[] = [];
      const sha = await Manifest.publishCuaDriverBrowserManifest(path, union, {
        readFile: async (file: string) => NodeFSP.readFile(file, "utf8"),
        writeFile: async (file: string, text: string) => {
          operations.push("write");
          expect(NodePath.dirname(file)).toBe(dir);
          await NodeFSP.writeFile(file, text, { flag: "wx", mode: 0o600 });
        },
        rename: async (from: string, to: string) => {
          operations.push("rename");
          expect(await NodeFSP.readFile(path, "utf8")).toBe(original);
          await NodeFSP.rename(from, to);
        },
        remove: async (file: string) => {
          operations.push("remove");
          await NodeFSP.rm(file, { force: true });
        },
      });
      const bytes = await NodeFSP.readFile(path);
      expect(operations.slice(0, 2)).toEqual(["write", "rename"]);
      expect(sha).toBe(NodeCrypto.createHash("sha256").update(bytes).digest("hex"));
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});
