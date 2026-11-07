// @effect-diagnostics nodeBuiltinImport:off -- Runs the exporter script as a subprocess with a fake Icon Composer tool.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

it("check mode renders all web icon sizes before reporting stale assets", () => {
  const temporaryDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-icon-tool-"));
  try {
    const tool = NodePath.join(temporaryDirectory, "ictool");
    NodeFS.writeFileSync(
      tool,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write(JSON.stringify({"bundle-version":"1","short-bundle-version":"2.0"})); process.exit(0); }
const output = args[args.indexOf("--output-file") + 1];
const size = Number(args[args.indexOf("--width") + 1]);
const png = Buffer.alloc(24);
Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
png.write("IHDR", 12); png.writeUInt32BE(size, 16); png.writeUInt32BE(size, 20);
fs.writeFileSync(output, png);
`,
      { mode: 0o755 },
    );
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      ["scripts/export-brand-icons.ts", "--check"],
      {
        cwd: NodePath.resolve(import.meta.dirname, ".."),
        env: { ...process.env, ICON_COMPOSER_TOOL: tool },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("IconExportAssetsStaleError");
    expect(result.stdout + result.stderr).toContain("assets/dev/blueprint-web-icon-192x192.png");
    expect(result.stdout + result.stderr).toContain("assets/prod/goat-black-web-icon-512x512.png");
    expect(result.stdout + result.stderr).not.toContain(
      "Generated development web icon is missing",
    );
  } finally {
    NodeFS.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
