// @effect-diagnostics nodeBuiltinImport:off - the boot probe serves production files from disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { verifyBuiltBoot } from "../../scripts/verify-built-boot.ts";

function buildFixture(module: string) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-test-built-boot-"));
  NodeFS.writeFileSync(
    NodePath.join(dir, "index.html"),
    '<div id="root"><div id="boot-shell"></div></div><script type="module" src="/boot.js"></script>',
  );
  NodeFS.writeFileSync(NodePath.join(dir, "boot.js"), module);
  return {
    dir,
    [Symbol.dispose]() {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    },
  };
}

it("boots a built chunk graph while backend endpoints are unavailable", async () => {
  using fixture = buildFixture(`
    const response = await fetch('/api/session');
    if (response.status !== 503) throw new Error('Expected an unavailable backend');
    await import('/main.js');
  `);
  NodeFS.writeFileSync(
    NodePath.join(fixture.dir, "main.js"),
    "document.getElementById('root').innerHTML = '<main>Mounted</main>';",
  );
  await verifyBuiltBoot(fixture.dir);
});

it.each([
  ["a broken chunk", "throw new ReferenceError('broken production chunk');"],
  ["a missing chunk", undefined],
])("rejects %s even when the boot fallback renders", async (_name, chunk) => {
  using fixture = buildFixture(`
    try { await import('/main.js'); }
    catch (error) {
      console.error(error);
      document.getElementById('boot-shell').innerHTML = '<button id="boot-error-reload">Reload</button>';
    }
  `);
  if (chunk !== undefined) NodeFS.writeFileSync(NodePath.join(fixture.dir, "main.js"), chunk);
  await expect(verifyBuiltBoot(fixture.dir)).rejects.toThrow("The built web client failed to boot");
});

it("rejects an absent build before launching Chromium", async () => {
  using fixture = buildFixture("");
  await expect(verifyBuiltBoot(NodePath.join(fixture.dir, "missing"))).rejects.toThrow(
    "No web build",
  );
});
