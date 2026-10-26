// @effect-diagnostics nodeBuiltinImport:off -- Writes a standalone build's file manifest.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { COMPUTER_USE_PROTOCOL_VERSION } from "@goat/contracts";
import type { CuaDriverRelease } from "@goat/shared/cuaDriverRelease";

export async function writeLinuxHelperManifest(input: {
  readonly out: string;
  readonly noticesDirectory: string;
  readonly arch: string;
  readonly helperVersion: string;
  readonly release: CuaDriverRelease;
}) {
  const { out, arch, helperVersion, release } = input;
  const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  const notices = ["LICENSE.md", "THIRD_PARTY_NOTICES.md", "node-runtime-NOTICE.md"];
  await NodeFSP.mkdir(NodePath.join(out, "notices"), { recursive: true });
  for (const name of notices)
    await NodeFSP.copyFile(
      NodePath.join(input.noticesDirectory, name),
      NodePath.join(out, "notices", name),
    );
  const files: Record<string, string> = {};
  const walk = async (directory: string) => {
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const path = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files[NodePath.relative(out, path)] = sha256(await NodeFSP.readFile(path));
    }
  };
  await walk(out);
  await NodeFSP.writeFile(
    NodePath.join(out, "manifest.json"),
    JSON.stringify(
      {
        name: "goat-computer-use",
        platform: "linux",
        arch,
        helperVersion,
        protocol: COMPUTER_USE_PROTOCOL_VERSION,
        driver: {
          name: "Cua Driver",
          license: "MIT AND MPL-2.0",
          notices: notices.map((name) => "notices/" + name),
          version: release.version,
          archive: release.archiveName,
          sha256: release.sha256,
          source: release.url,
        },
        files: Object.fromEntries(Object.entries(files).toSorted(([a], [b]) => a.localeCompare(b))),
      },
      null,
      2,
    ) + "\n",
  );
}
