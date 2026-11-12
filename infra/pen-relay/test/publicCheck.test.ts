// @effect-diagnostics nodeBuiltinImport:off - Drives the pre-deploy check over scratch folders.
// A deploy publishes infra/pen-relay/public as is, so a local test build (loopback relays) or an
// install.sh whose version has no binaries must never go out.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const script = NodePath.resolve(import.meta.dirname, "../scripts/check-public.ts");

const archives = [
  "pen-linux-amd64.gz",
  "pen-linux-arm64.gz",
  "pen-darwin-arm64.gz",
  "pen-darwin-amd64.gz",
  "pen-windows-amd64.exe.gz",
  "pen-windows-arm64.exe.gz",
];

/** install.ps1's default lines, as build.sh fills them in. */
const ps1 = (relays: string, version: string) =>
  [
    "$PenRelay = if ($env:PEN_RELAY) { $env:PEN_RELAY } else { '" + relays.split(" ")[0] + "' }",
    "$PenRelays = if ($env:PEN_RELAYS) { $env:PEN_RELAYS } else { '" + relays + "' }",
    "$Version = if ($env:PEN_VERSION) { $env:PEN_VERSION } else { '" + version + "' }",
    "",
  ].join("\n");

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
  NodeFS.writeFileSync(NodePath.join(dir, "install.ps1"), ps1(relays, version));
  if (withBinaries) {
    const dl = NodePath.join(dir, "dl", version);
    NodeFS.mkdirSync(dl, { recursive: true });
    const sums = archives.map((name) => {
      const body = Buffer.from(`binary ${name}`);
      NodeFS.writeFileSync(NodePath.join(dl, name), body);
      return `${NodeCrypto.createHash("sha256").update(body).digest("hex")}  ${name}\n`;
    });
    NodeFS.writeFileSync(NodePath.join(dl, "SHA256SUMS"), sums.join(""));
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

  it("refuses a release whose archives are missing or do not match SHA256SUMS", () => {
    const missing = publicDir("https://a.example", "1.2.3", true);
    NodeFS.rmSync(NodePath.join(missing, "dl", "1.2.3", "pen-darwin-amd64.gz"));
    const r1 = run(missing);
    expect(r1.status).toBe(1);
    expect(r1.stderr).toContain("pen-darwin-amd64.gz");

    const changed = publicDir("https://a.example", "1.2.3", true);
    NodeFS.writeFileSync(NodePath.join(changed, "dl", "1.2.3", "pen-linux-arm64.gz"), "other");
    const r2 = run(changed);
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain("pen-linux-arm64.gz");

    const unlisted = publicDir("https://a.example", "1.2.3", true);
    const sums = NodePath.join(unlisted, "dl", "1.2.3", "SHA256SUMS");
    NodeFS.writeFileSync(sums, NodeFS.readFileSync(sums, "utf8").split("\n").slice(1).join("\n"));
    const r3 = run(unlisted);
    expect(r3.status).toBe(1);
    expect(r3.stderr).toContain("pen-linux-amd64.gz");
  });

  it("refuses a SHA256SUMS that install.sh would read differently: a second line for an archive, or a binary-mode line", () => {
    const doubled = publicDir("https://a.example", "1.2.3", true);
    const sums = NodePath.join(doubled, "dl", "1.2.3", "SHA256SUMS");
    const lines = NodeFS.readFileSync(sums, "utf8");
    NodeFS.writeFileSync(sums, `${"0".repeat(64)}  pen-linux-amd64.gz\n${lines}`);
    const r1 = run(doubled);
    expect(r1.status).toBe(1);
    expect(r1.stderr).toContain("pen-linux-amd64.gz");

    const binary = publicDir("https://a.example", "1.2.3", true);
    const sums2 = NodePath.join(binary, "dl", "1.2.3", "SHA256SUMS");
    NodeFS.writeFileSync(
      sums2,
      NodeFS.readFileSync(sums2, "utf8").replace("  pen-darwin-arm64.gz", " *pen-darwin-arm64.gz"),
    );
    const r2 = run(binary);
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain("pen-darwin-arm64.gz");
  });

  it("refuses a release whose install.ps1 is missing or installs other relays or another version", () => {
    const missing = publicDir("https://a.example", "1.2.3", true);
    NodeFS.rmSync(NodePath.join(missing, "install.ps1"));
    const r1 = run(missing);
    expect(r1.status).toBe(1);
    expect(r1.stderr).toContain("install.ps1");

    for (const [relays, version] of [
      ["http://127.0.0.1:8787", "1.2.3"],
      ["https://a.example https://b.example", "1.2.3"],
      ["https://a.example", "0.0.0-check"],
    ] as const) {
      const other = publicDir("https://a.example", "1.2.3", true);
      NodeFS.writeFileSync(NodePath.join(other, "install.ps1"), ps1(relays, version));
      const r = run(other);
      expect(r.status, `${relays} ${version}`).toBe(1);
      expect(r.stderr).toContain("install.ps1");
    }
  });

  it("refuses a release without a Windows archive", () => {
    const dir = publicDir("https://a.example", "1.2.3", true);
    NodeFS.rmSync(NodePath.join(dir, "dl", "1.2.3", "pen-windows-arm64.exe.gz"));
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("pen-windows-arm64.exe.gz");
  });
});
