// @effect-diagnostics nodeBuiltinImport:off -- Verifies the standalone helper's on-disk payload.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import { cuaDriverRelease } from "@goat/shared/cuaDriverRelease";

import { writeLinuxHelperManifest } from "./lib/computer-use-helper-linux-manifest.ts";

it("ships and hashes all Cua Driver notices with the Linux standalone helper (#1605)", async () => {
  const out = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-linux-helper-"));
  try {
    const noticesDirectory = NodePath.resolve(
      import.meta.dirname,
      "../apps/desktop/src/cua/notices",
    );
    await NodeFSP.mkdir(NodePath.join(out, "cua-driver"));
    // Additional archive-root notices must survive packaging alongside the executable.
    for (const name of ["cua-driver", "LICENSE", "THIRD_PARTY_NOTICES.md"])
      await NodeFSP.writeFile(NodePath.join(out, "cua-driver", name), name);
    const release = cuaDriverRelease("linux", "x64")!;
    await writeLinuxHelperManifest({
      out,
      noticesDirectory,
      arch: "x64",
      helperVersion: "1.0.0",
      release,
    });
    const manifest = JSON.parse(
      await NodeFSP.readFile(NodePath.join(out, "manifest.json"), "utf8"),
    );
    expect(manifest.driver).toMatchObject({
      license: "MIT AND MPL-2.0",
      version: release.version,
      source: release.url,
      notices: [
        "notices/LICENSE.md",
        "notices/THIRD_PARTY_NOTICES.md",
        "notices/node-runtime-NOTICE.md",
      ],
    });
    for (const name of ["LICENSE.md", "THIRD_PARTY_NOTICES.md", "node-runtime-NOTICE.md"]) {
      const bytes = await NodeFSP.readFile(NodePath.join(noticesDirectory, name));
      expect(await NodeFSP.readFile(NodePath.join(out, "notices", name))).toEqual(bytes);
      expect(manifest.files["notices/" + name]).toBe(
        NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      );
    }
    for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"])
      expect(manifest.files["cua-driver/" + name]).toBe(
        NodeCrypto.createHash("sha256").update(name).digest("hex"),
      );
    await expect(
      writeLinuxHelperManifest({
        out,
        noticesDirectory: NodePath.join(out, "missing"),
        arch: "x64",
        helperVersion: "1.0.0",
        release,
      }),
    ).rejects.toThrow();
  } finally {
    await NodeFSP.rm(out, { recursive: true, force: true });
  }
});
