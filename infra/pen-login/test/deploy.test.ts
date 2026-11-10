// @effect-diagnostics nodeBuiltinImport:off - Drives the deploy script with a stand-in wrangler.
// The login key must never be created without an operator-held copy: the Worker secret cannot be
// read back and a lost key orphans every mesh.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const script = NodePath.resolve(import.meta.dirname, "../scripts/deploy.ts");
const CLIENT = {
  web: {
    client_id: "1-abc.apps.googleusercontent.com",
    client_secret: "client-secret-value",
    redirect_uris: ["https://pen-login.pos090001.workers.dev/v1/auth/google/callback"],
  },
};

function sandbox(
  existingSecrets: string[],
  opts: { deployExit?: number; listError?: string } = {},
) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pen-deploy-"));
  NodeFS.chmodSync(dir, 0o700);
  const sent = NodePath.join(dir, "sent.json");
  const wrangler = NodePath.join(dir, "wrangler");
  NodeFS.writeFileSync(
    wrangler,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const a = process.argv.slice(2);",
      `if (a[0] === 'secret' && a[1] === 'list' && ${JSON.stringify(opts.listError ?? "")}) { console.error(${JSON.stringify(opts.listError ?? "")}); process.exit(1); }`,
      `if (a[0] === 'secret' && a[1] === 'list') { console.log(JSON.stringify(${JSON.stringify(existingSecrets.map((name) => ({ name })))})); process.exit(0); }`,
      `if (a[0] === 'deploy') { fs.copyFileSync(a[a.indexOf('--secrets-file') + 1], ${JSON.stringify(sent)}); process.exit(${opts.deployExit ?? 0}); }`,
      "process.exit(3);",
    ].join("\n"),
    { mode: 0o755 },
  );
  const client = NodePath.join(dir, "client.json");
  NodeFS.writeFileSync(client, JSON.stringify(CLIENT), { mode: 0o600 });
  const run = (...args: string[]) => {
    const r = NodeChildProcess.spawnSync(process.execPath, [script, client, ...args], {
      encoding: "utf8",
      env: { ...process.env, PEN_WRANGLER: wrangler },
    });
    return { status: r.status, out: r.stdout + r.stderr };
  };
  const uploaded = () =>
    NodeFS.existsSync(sent)
      ? (JSON.parse(NodeFS.readFileSync(sent, "utf8")) as Record<string, string>)
      : undefined;
  return {
    dir,
    run,
    uploaded,
    cleanup: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
  };
}

describe("deploy:secrets and the login key", () => {
  it("refuses to create a login key without a file to keep it in", () => {
    const s = sandbox([]);
    try {
      const r = s.run();
      expect(r.status).toBe(1);
      expect(r.out).toContain("--signing-key-file");
      expect(s.uploaded()).toBeUndefined();
    } finally {
      s.cleanup();
    }
  });

  it("creates the key in a new 0600 file, uploads that key and never prints it", () => {
    const s = sandbox([]);
    try {
      const keyFile = NodePath.join(s.dir, "login-key");
      const r = s.run("--signing-key-file", keyFile);
      expect(r.status).toBe(0);
      const seed = NodeFS.readFileSync(keyFile, "utf8").trim();
      expect(Buffer.from(seed, "base64url")).toHaveLength(32);
      expect(NodeFS.statSync(keyFile).mode & 0o777).toBe(0o600);
      expect(s.uploaded()?.LOGIN_SIGNING_KEY).toBe(seed);
      expect(r.out).not.toContain(seed);
      expect(r.out).toMatch(/login key kid [a-z2-7]{8}/);
    } finally {
      s.cleanup();
    }
  });

  it("restores the key from an existing file", () => {
    const s = sandbox([]);
    try {
      const keyFile = NodePath.join(s.dir, "login-key");
      const seed = Buffer.alloc(32, 7).toString("base64url");
      NodeFS.writeFileSync(keyFile, seed + "\n", { mode: 0o600 });
      expect(s.run("--signing-key-file", keyFile).status).toBe(0);
      expect(s.uploaded()?.LOGIN_SIGNING_KEY).toBe(seed);
    } finally {
      s.cleanup();
    }
  });

  it("keeps the Worker's key and refuses a file that would replace it", () => {
    const s = sandbox(["LOGIN_SIGNING_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
    try {
      const kept = s.run();
      expect(kept.status).toBe(0);
      expect(s.uploaded()?.LOGIN_SIGNING_KEY).toBeUndefined();
      const keyFile = NodePath.join(s.dir, "login-key");
      NodeFS.writeFileSync(keyFile, Buffer.alloc(32, 7).toString("base64url"), { mode: 0o600 });
      const replaced = s.run("--signing-key-file", keyFile);
      expect(replaced.status).toBe(1);
      expect(replaced.out).toContain("already has LOGIN_SIGNING_KEY");
    } finally {
      s.cleanup();
    }
  });

  it("refuses a key file in a directory other users can read, or inside the repository", () => {
    const s = sandbox([]);
    try {
      const open = NodePath.join(s.dir, "open");
      NodeFS.mkdirSync(open, { mode: 0o755 });
      NodeFS.chmodSync(open, 0o755);
      expect(s.run("--signing-key-file", NodePath.join(open, "login-key")).status).toBe(1);
      const inRepo = NodePath.resolve(import.meta.dirname, "login-key-should-not-exist");
      expect(s.run("--signing-key-file", inRepo).status).toBe(1);
      expect(NodeFS.existsSync(inRepo)).toBe(false);
      expect(s.uploaded()).toBeUndefined();
    } finally {
      s.cleanup();
    }
  });

  it("refuses a key file reached through a symlink into the repository", () => {
    const s = sandbox([]);
    const target = NodePath.resolve(import.meta.dirname, "../node_modules/.pen-deploy-test");
    try {
      NodeFS.mkdirSync(target, { recursive: true, mode: 0o700 });
      NodeFS.chmodSync(target, 0o700);
      const link = NodePath.join(s.dir, "link");
      NodeFS.symlinkSync(target, link);
      expect(s.run("--signing-key-file", NodePath.join(link, "login-key")).status).toBe(1);
      expect(NodeFS.existsSync(NodePath.join(target, "login-key"))).toBe(false);
    } finally {
      NodeFS.rmSync(target, { recursive: true, force: true });
      s.cleanup();
    }
  });

  it("says nothing was sent when wrangler deploy fails", () => {
    const s = sandbox(["LOGIN_SIGNING_KEY"], { deployExit: 1 });
    try {
      const r = s.run();
      expect(r.status).toBe(1);
      expect(r.out).not.toContain("secrets sent");
    } finally {
      s.cleanup();
    }
  });

  it("treats only a missing Worker as having no secrets, not any 'not found' error", () => {
    const s = sandbox([], { listError: "✘ [ERROR] Authentication error: account not found" });
    try {
      const keyFile = NodePath.join(s.dir, "login-key");
      const r = s.run("--signing-key-file", keyFile);
      expect(r.status).toBe(1);
      expect(NodeFS.existsSync(keyFile)).toBe(false);
      expect(s.uploaded()).toBeUndefined();
    } finally {
      s.cleanup();
    }
  });
});
