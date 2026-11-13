// @effect-diagnostics nodeBuiltinImport:off -- The Windows lookup uses temporary PATH entries.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@goat/shared/HostProcess";
import { describe, expect, it } from "vite-plus/test";
import { resolvePenBinary } from "./penPipe.ts";

describe("Windows Pen binary lookup", () => {
  it.runIf(HostProcess.Platform.defaultValue() === "win32")(
    "finds only an executable in an absolute PATH entry",
    async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pen-binary-"));
      try {
        const empty = NodePath.join(root, "empty");
        const bin = NodePath.join(root, "bin");
        await NodeFSP.mkdir(empty);
        await NodeFSP.mkdir(bin);
        await NodeFSP.writeFile(NodePath.join(bin, "pen.exe"), "");
        expect(
          await resolvePenBinary({
            platform: "win32",
            path: ["relative", empty, bin].join(NodePath.delimiter),
          }),
        ).toBe(await NodeFSP.realpath(NodePath.join(bin, "pen.exe")));
        expect(await resolvePenBinary({ platform: "win32", path: empty })).toBeUndefined();
        expect(await resolvePenBinary({ platform: "win32", path: "bin" })).toBeUndefined();
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
});
