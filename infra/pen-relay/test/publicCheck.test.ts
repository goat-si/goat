// @effect-diagnostics nodeBuiltinImport:off - Drives the pre-deploy check over scratch folders.
// A deploy publishes infra/pen-relay/public as is, so a local test build (loopback relays) or an
// install.sh whose version has no binaries must never go out.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const script = NodePath.resolve(import.meta.dirname, "../scripts/check-public.ts");

function publicDir(relays: string, version: string, withBinaries: boolean) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pen-public-"));
  NodeFS.writeFileSync(
    NodePath.join(dir, "install.sh"),
    [
      "#!/bin/sh",
      'PEN_RELAY="${PEN_RELAY:-' + relays.split(" ")[0] + '}"',
      'PEN_RELAYS="${PEN_RELAYS:-' + relays + '}"',
      'VERSION="${PEN_VERSION:-' + version + '}"',
      "",
    ].join("\n"),
  );
  if (withBinaries) {
    NodeFS.mkdirSync(NodePath.join(dir, "dl", version), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(dir, "dl", version, "SHA256SUMS"),
      "x  pen-linux-amd64.gz\n",
    );
  }
  return dir;
}

const run = (dir: string) =>
  NodeChildProcess.spawnSync(process.execPath, [script, dir], { encoding: "utf8" });

describe("pre-deploy check of public/", () => {
  it("passes a release build", () => {
    const dir = publicDir(
      "https://pen-relay.example.workers.dev https://relay.example",
      "1.2.3",
      true,
    );
    const r = run(dir);
    expect(r.status, r.stderr).toBe(0);
  });

  it("refuses an install.sh that points at loopback or plain http relays", () => {
    for (const relays of [
      "http://127.0.0.1:8787 http://127.0.0.1:8788",
      "https://a.example http://b.example",
      "https://localhost:1",
    ]) {
      const r = run(publicDir(relays, "1.2.3", true));
      expect(r.status, relays).toBe(1);
      expect(r.stderr).toContain("relay");
    }
  });

  it("refuses an install.sh whose version has no binaries", () => {
    const r = run(publicDir("https://a.example", "0.0.0-check", false));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("0.0.0-check");
  });
});
