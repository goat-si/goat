// @effect-diagnostics nodeBuiltinImport:off -- Builds the zip Azure returns and stands in for az writing it.
import * as NodeFS from "node:fs";
import * as NodeZlib from "node:zlib";
import { afterEach, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as AzureDevOpsPullRequestCli from "./AzureDevOpsPullRequestCli.ts";
import { argsOfCall, layer, mockedExecute, output } from "./azureDevOpsPullRequestCli.testkit.ts";

afterEach(() => {
  mockedExecute.mockReset();
});

/** Entries as Azure streams them: data descriptors, with sizes only in the central directory. */
function streamedZip(
  entries: ReadonlyArray<{
    readonly name: string;
    readonly data: Uint8Array;
    readonly stored?: true;
  }>,
): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const method = entry.stored ? 0 : 8;
    const body = entry.stored ? Buffer.from(entry.data) : NodeZlib.deflateRawSync(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0x0008, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(name.length, 26);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(body.length, 8);
    descriptor.writeUInt32LE(entry.data.length, 12);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0008, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(local, name, body, descriptor);
    directory.push(central, name);
    offset += local.length + name.length + body.length + descriptor.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralDirectory, end]);
}

layer("Azure DevOps pull request blob reads", (it) => {
  it.effect(
    "reads a batch of files from one blobs zip, keeping only what Azure's read would say",
    () =>
      Effect.gen(function* () {
        const id = (digit: string) => digit.repeat(40);
        const utf8 = (text: string) => new TextEncoder().encode(text);
        let sent = "";
        mockedExecute.mockImplementationOnce((input) =>
          Effect.sync(() => {
            const flag = (name: string) => input.args[input.args.indexOf(name) + 1] ?? "";
            sent = NodeFS.readFileSync(flag("--in-file"), "utf8");
            NodeFS.writeFileSync(
              flag("--out-file"),
              streamedZip([
                { name: id("a"), data: utf8("plain text\n") },
                { name: id("b"), data: utf8("\uFEFFcafé ✓\n") },
                { name: id("c"), data: Uint8Array.of(0x89, 0x50, 0x00, 0x01) },
                // Windows-1252 "café" and UTF-16: Azure decodes these itself.
                { name: id("d"), data: Uint8Array.of(0x63, 0x61, 0x66, 0xe9) },
                { name: id("e"), data: Uint8Array.of(0xff, 0xfe, 0x68, 0x00) },
                { name: id("f"), data: utf8("stored\n"), stored: true },
                { name: id("9"), data: utf8("never asked for\n") },
              ]),
            );
            return output("");
          }),
        );
        const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

        const blobs = yield* cli.readBlobs({
          cwd: "/w",
          location: { project: "platform", repository: "web" },
          objectIds: [id("A"), id("b"), id("C"), id("d"), id("e"), id("f"), id("a"), "../etc"],
        });

        expect(JSON.parse(sent)).toEqual([id("A"), id("b"), id("C"), id("d"), id("e"), id("f")]);
        expect(argsOfCall(0)).toEqual(
          expect.arrayContaining(["blobs", "POST", "application/zip", "project=platform"]),
        );
        expect(Object.fromEntries(blobs)).toEqual({
          [id("a")]: { contents: "plain text\n", isBinary: false },
          [id("b")]: { contents: "café ✓\n", isBinary: false },
          [id("c")]: { contents: "", isBinary: true },
          [id("f")]: { contents: "stored\n", isBinary: false },
        });
      }),
  );

  it.effect("leaves blobs past the batch's total size to per-file reads", () =>
    Effect.gen(function* () {
      const ids = ["1", "2", "3", "4", "5", "6"].map((digit) => digit.repeat(40));
      // Compresses to a few KiB each, so only the inflated total can bound memory.
      const blob = new Uint8Array(3 * 1024 * 1024).fill(0x61);
      mockedExecute.mockImplementationOnce((input) =>
        Effect.sync(() => {
          NodeFS.writeFileSync(
            input.args[input.args.indexOf("--out-file") + 1] ?? "",
            streamedZip(ids.map((name) => ({ name, data: blob }))),
          );
          return output("");
        }),
      );
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;

      const blobs = yield* cli.readBlobs({
        cwd: "/w",
        location: { project: "platform", repository: "web" },
        objectIds: ids,
      });

      expect([...blobs.keys()]).toEqual(ids.slice(0, 5));
    }),
  );
});
