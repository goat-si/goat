import * as HostProcess from "@goat/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as NodeZlib from "node:zlib";

import * as PreviewBrowser from "./PreviewBrowser.ts";

// NTFS cannot enforce POSIX modes; choose the host platform.
/** For tests whose browser is mocked and never launches an executable. */
export const unusedPreviewBrowser = PreviewBrowser.PreviewBrowser.of({
  executable: Effect.die("mock Chromium does not need an executable"),
  installed: Effect.die("mock Chromium does not need an executable"),
  installStatus: Effect.succeed({ _tag: "installed" }),
});

// NTFS cannot enforce POSIX modes; choose the host platform.
export const hostPlatform: NodeJS.Platform =
  HostProcess.Platform.defaultValue() === "win32" ? "win32" : "linux";
export const executableName =
  hostPlatform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
export const ROOT = "chrome-headless-shell-fixture/";

export const makeZip = (
  entries: ReadonlyArray<{ readonly name: string; readonly data?: string; readonly mode: number }>,
) => {
  const records: Array<Buffer> = [];
  const directory: Array<Buffer> = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data ?? "");
    const crc = NodeZlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    records.push(local, name, data);
    directory.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, centralDirectory, end]);
};

export const browserArchive = makeZip([
  { name: ROOT, mode: 0o40755 },
  { name: `${ROOT}${executableName}`, data: "#!/bin/sh\n", mode: 0o100755 },
  { name: `${ROOT}libEGL.so`, data: "library", mode: 0o100755 },
  { name: `${ROOT}locales/`, mode: 0o40755 },
  { name: `${ROOT}locales/en-US.pak`, data: "strings", mode: 0o100644 },
]);

export const makeHarness = Effect.fn("test.makePreviewBrowser")(function* (
  options: {
    readonly version?: string;
    readonly archive?: Buffer;
    readonly sha256?: string;
    readonly body?: Stream.Stream<Uint8Array>;
    /** One body per request, in order; later requests fall back to body. */
    readonly bodies?: ReadonlyArray<Stream.Stream<Uint8Array>>;
    readonly wait?: Duration.Input;
    readonly unsupported?: boolean;
    readonly release?: PreviewBrowser.PreviewBrowserRelease | null;
    readonly variant?: PreviewBrowser.PreviewBrowserVariant;
    readonly executablePath?: string;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-preview-browser-test-" });
  const archive = options.archive ?? browserArchive;
  const crypto = yield* Crypto.Crypto;
  const sha256 =
    options.sha256 ?? Hex.encode(yield* crypto.digest("SHA-256", archive).pipe(Effect.orDie));
  const requests: Array<string> = [];
  const release =
    options.release !== undefined
      ? options.release
      : options.unsupported
        ? null
        : {
            version: options.version ?? "1.2.3",
            platform: "fixture",
            url: "https://storage.googleapis.com/chrome-headless-shell-fixture.zip",
            bytes: archive.byteLength,
            sha256,
          };
  const browser = yield* PreviewBrowser.makePreviewBrowser({
    baseDir,
    release,
    ...(options.variant === undefined ? {} : { variant: options.variant }),
    ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
    ...(options.wait === undefined ? {} : { wait: options.wait }),
  }).pipe(
    Effect.provideService(HostProcess.Platform, hostPlatform),
    Effect.provideService(HostProcess.Architecture, "x64"),
    Effect.provideService(HostProcess.Environment, options.env ?? {}),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url);
          const response = HttpClientResponse.fromWeb(request, new Response(null));
          return Object.defineProperty(response, "stream", {
            value:
              options.bodies?.[requests.length - 1] ??
              options.body ??
              Stream.make(archive.subarray(0, 40), archive.subarray(40)),
          });
        }),
      ),
    ),
  );
  const toolDirectory =
    options.variant === "chrome" || options.env?.GOAT_SERVER_BROWSER_VARIANT?.trim() === "chrome"
      ? "chrome"
      : "chrome-headless-shell";
  const installRoot = path.join(baseDir, "tools", toolDirectory, "fixture");
  return { browser, fs, path, baseDir, installRoot, requests };
});
