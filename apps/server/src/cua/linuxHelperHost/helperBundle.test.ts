// @effect-diagnostics nodeBuiltinImport:off -- Builds real helper bundles on disk.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { makeHelperBundleCheck, MANIFEST, SIGNATURE } from "./helperBundle.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

const sha256 = (bytes: string | Buffer) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** A bundle as the build script writes it: the helper, a driver file and their manifest. */
function bundle(files: Record<string, string> = {}) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-helper-bundle-"));
  roots.push(root);
  const directory = NodePath.join(root, "goat-computer-use");
  const contents = {
    "goat-computer-use.mjs": "console.log('helper')",
    "cua-driver/cua-driver": "driver",
    ...files,
  };
  for (const [name, text] of Object.entries(contents)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(directory, name)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(directory, name), text);
  }
  const manifest = JSON.stringify({
    name: "goat-computer-use",
    platform: "linux",
    arch: "x64",
    files: Object.fromEntries(Object.entries(contents).map(([name, text]) => [name, sha256(text)])),
  });
  NodeFS.writeFileSync(NodePath.join(directory, MANIFEST), manifest);
  for (const path of [directory, NodePath.join(directory, "cua-driver")])
    NodeFS.chmodSync(path, 0o755);
  const entry = NodePath.join(directory, "goat-computer-use.mjs");
  const keys = NodeCrypto.generateKeyPairSync("ed25519");
  return {
    directory,
    entry,
    at: (name: string) => NodePath.join(directory, name),
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    sign: (key = keys.privateKey) =>
      NodeFS.writeFileSync(
        NodePath.join(directory, SIGNATURE),
        NodeCrypto.sign(null, Buffer.from(manifest), key).toString("base64") + "\n",
      ),
  };
}

describe("Linux helper bundle check (#1224)", () => {
  it("lets a bundle that matches its manifest run", async () => {
    const b = bundle();
    expect(await makeHelperBundleCheck(b.entry, [])()).toBeUndefined();
  });

  it("with a release key, runs only a manifest that key signed", async () => {
    const b = bundle();
    const check = makeHelperBundleCheck(b.entry, [b.publicKey]);
    expect(await check()).toContain("not signed by GOAT (" + SIGNATURE + ")");
    b.sign(NodeCrypto.generateKeyPairSync("ed25519").privateKey);
    expect(await check()).toContain("not signed by GOAT's release key");
    b.sign();
    expect(await check()).toBeUndefined();
  });

  it.each([
    [
      "a changed file",
      (b: ReturnType<typeof bundle>) => NodeFS.writeFileSync(b.at("cua-driver/cua-driver"), "evil"),
      "cua-driver/cua-driver does not match",
    ],
    [
      "an unlisted file",
      (b: ReturnType<typeof bundle>) => NodeFS.writeFileSync(b.at("cua-driver/libinject.so"), "x"),
      "cua-driver/libinject.so is not in",
    ],
    [
      "a missing file",
      (b: ReturnType<typeof bundle>) => NodeFS.rmSync(b.at("cua-driver/cua-driver")),
      "cua-driver/cua-driver is missing",
    ],
    [
      "a symbolic link",
      (b: ReturnType<typeof bundle>) => {
        NodeFS.rmSync(b.at("cua-driver/cua-driver"));
        NodeFS.symlinkSync("/bin/sh", b.at("cua-driver/cua-driver"));
      },
      "cua-driver/cua-driver is a symbolic link",
    ],
    [
      "a file other users can write",
      (b: ReturnType<typeof bundle>) => NodeFS.chmodSync(b.at("cua-driver/cua-driver"), 0o666),
      "cua-driver/cua-driver can be changed by other users",
    ],
    [
      "a folder other users can write",
      (b: ReturnType<typeof bundle>) => NodeFS.chmodSync(b.at("cua-driver"), 0o777),
      "cua-driver can be changed by other users",
    ],
  ])("refuses a bundle with %s, and says which file", async (_name, change, reason) => {
    const b = bundle();
    const check = makeHelperBundleCheck(b.entry, []);
    expect(await check()).toBeUndefined();
    change(b);
    const refused = await check();
    expect(refused).toContain(reason);
    expect(refused).toMatch(/^GOAT's Linux computer use helper was not started: /u);
  });

  it("does not take a file named after an object's own keys as listed", async () => {
    const b = bundle();
    NodeFS.writeFileSync(b.at("constructor"), "x");
    expect(await makeHelperBundleCheck(b.entry, [])()).toContain("constructor is not in");
  });

  it("refuses to run a file the manifest does not name", async () => {
    const b = bundle();
    expect(await makeHelperBundleCheck(b.at("gone.mjs"), [])()).toContain("gone.mjs is not in");
  });

  it("refuses a bundle with no manifest", async () => {
    const b = bundle();
    NodeFS.rmSync(b.at(MANIFEST));
    expect(await makeHelperBundleCheck(b.entry, [])()).toContain(MANIFEST + " is missing");
  });
});
