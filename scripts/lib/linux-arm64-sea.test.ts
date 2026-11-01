// TEMPORARY one-time Node fix. Remove when fixed: https://github.com/nodejs/node/issues/67048
// @effect-diagnostics nodeBuiltinImport:off - Runs an isolated selected-runtime stand-in.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@goat/shared/HostProcess";
import { assertLinuxArm64PageCompatibility, injectLinuxArm64Sea } from "./linux-arm64-sea.ts";

function elf(loads: Array<{ offset: bigint; address: bigint; size: bigint }>) {
  const bytes = new Uint8Array(64 + loads.length * 56);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  view.setUint16(18, 183, true);
  view.setBigUint64(32, 64n, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, loads.length, true);
  loads.forEach((load, index) => {
    const start = 64 + index * 56;
    view.setUint32(start, 1, true);
    view.setBigUint64(start + 8, load.offset, true);
    view.setBigUint64(start + 16, load.address, true);
    view.setBigUint64(start + 40, load.size, true);
    view.setBigUint64(start + 48, 0x1000n, true);
  });
  return bytes;
}

describe("Linux ARM64 SEA page compatibility", () => {
  it("rejects the relocated SEA note from nightly 3512", () => {
    expect(() =>
      assertLinuxArm64PageCompatibility(
        elf([{ offset: 0x8faf000n, address: 0x1015d000n, size: 0x1003000n }]),
      ),
    ).toThrow(/64 KiB/);
  });

  it("accepts congruent offsets even with a smaller declared alignment", () => {
    expect(() =>
      assertLinuxArm64PageCompatibility(
        elf([
          { offset: 0n, address: 0x400000n, size: 0x10000n },
          { offset: 0x20000n, address: 0x420000n, size: 0x10000n },
        ]),
      ),
    ).not.toThrow();
  });

  it("rejects segments that share a 64 KiB page", () => {
    expect(() =>
      assertLinuxArm64PageCompatibility(
        elf([
          { offset: 0n, address: 0x400000n, size: 0x11000n },
          { offset: 0x11000n, address: 0x411000n, size: 0x1000n },
        ]),
      ),
    ).toThrow(/overlap/);
  });

  it("rejects missing or malformed program headers", () => {
    expect(() => assertLinuxArm64PageCompatibility(elf([]))).toThrow();
    expect(() => assertLinuxArm64PageCompatibility(new Uint8Array(64))).toThrow();
    expect(() =>
      assertLinuxArm64PageCompatibility(
        elf([{ offset: 0n, address: 0x400000n, size: 1n }]).subarray(0, 70),
      ),
    ).toThrow();
  });

  it("rejects non-ARM64, big-endian, unsafe and empty LOAD tables", () => {
    for (const [offset, value] of [
      [18, 62],
      [5, 2],
      [54, 55],
    ] as const) {
      const bytes = elf([{ offset: 0n, address: 0x400000n, size: 1n }]);
      bytes[offset] = value;
      expect(() => assertLinuxArm64PageCompatibility(bytes)).toThrow();
    }
    const bytes = elf([{ offset: 0n, address: 0x400000n, size: 0n }]);
    expect(() => assertLinuxArm64PageCompatibility(bytes)).toThrow(/no LOAD/);
    new DataView(bytes.buffer).setBigUint64(32, 1n << 60n, true);
    expect(() => assertLinuxArm64PageCompatibility(bytes)).toThrow(/header table/);
  });

  it("checks views at their byte offset and accepts adjacent whole pages", () => {
    const bytes = elf([
      { offset: 0n, address: 0x400000n, size: 0x10000n },
      { offset: 0x10000n, address: 0x410000n, size: 0x10000n },
    ]);
    const padded = new Uint8Array(bytes.length + 9);
    padded.set(bytes, 9);
    expect(() => assertLinuxArm64PageCompatibility(padded.subarray(9))).not.toThrow();
  });
});

describe("Linux ARM64 SEA injection", () => {
  it.live.each(["success", "blob-failure", "injection-failure"])(
    "%s uses the selected runtime and propagates build failures",
    (mode) =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fs.makeTempDirectoryScoped({ prefix: "goat-sea-test-" });
        const nodePath = path.join(temp, "selected-node");
        const outputPath = path.join(temp, "goat");
        const bundlePath = path.join(temp, "bin.mjs");
        yield* fs.writeFileString(bundlePath, "export {};\n");
        const selectedNode = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--experimental-sea-config') {
  if (${JSON.stringify(mode)} === 'blob-failure') process.exit(23);
  const config = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  fs.writeFileSync(config.output, JSON.stringify(config));
} else {
  if (${JSON.stringify(mode)} === 'injection-failure') process.exit(24);
  if (args[2] !== 'NODE_SEA_BLOB' || args[4] !== '--sentinel-fuse' ||
      args[5] !== 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2') process.exit(25);
  fs.appendFileSync(args[1], '\\n' + fs.readFileSync(args[3], 'utf8'));
}
`;
        yield* fs.writeFileString(nodePath, selectedNode);
        yield* fs.chmod(nodePath, 0o755);
        const result = yield* Effect.result(
          injectLinuxArm64Sea({ bundlePath, outputPath, nodePath, verbose: false }),
        );
        if (mode === "success") {
          expect(result._tag).toBe("Success");
          const output = yield* fs.readFileString(outputPath);
          expect(output.startsWith(selectedNode)).toBe(true);
          expect(output).toContain(JSON.stringify(bundlePath));
          expect(output).toContain('"mainFormat":"module"');
          expect(output).toContain('"useCodeCache":false');
          expect((yield* fs.stat(outputPath)).mode & 0o111).not.toBe(0);
        } else {
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") {
            expect(String(result.failure)).toContain(mode === "blob-failure" ? "23" : "24");
          }
          if (mode === "blob-failure") expect(yield* fs.exists(outputPath)).toBe(false);
        }
        expect(yield* fs.readFileString(nodePath)).toBe(selectedNode);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
