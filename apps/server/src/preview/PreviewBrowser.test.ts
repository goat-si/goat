import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { symlinksSupported } from "@goat/shared/testing/symlinks";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import {
  browserArchive,
  executableName,
  hostPlatform,
  makeHarness,
  makeZip,
  ROOT,
} from "./PreviewBrowser.testkit.ts";

it.layer(NodeServices.layer)("PreviewBrowser", (it) => {
  it.effect("installs a verified download with its file modes and then reuses it", () =>
    Effect.gen(function* () {
      const { browser, fs, path, installRoot, requests } = yield* makeHarness();
      yield* fs.makeDirectory(path.join(installRoot, "1.0.0"), { recursive: true });
      const active = path.join(installRoot, ".install-other");
      const abandoned = path.join(installRoot, ".install-abandoned");
      yield* fs.makeDirectory(active);
      yield* fs.makeDirectory(abandoned);
      const twoHoursAgo = DateTime.toDate(DateTime.subtract(yield* DateTime.now, { hours: 2 }));
      yield* fs.utimes(abandoned, twoHoursAgo, twoHoursAgo);
      expect(yield* browser.installed).toEqual(Option.none());

      const executable = yield* browser.executable;

      const version = path.join(installRoot, "1.2.3");
      expect(executable).toBe(path.join(version, executableName));
      expect(yield* fs.readFileString(path.join(version, "locales", "en-US.pak"))).toBe("strings");
      if (hostPlatform !== "win32") {
        const mode = (file: string) =>
          fs.stat(path.join(version, file)).pipe(Effect.map((info) => info.mode & 0o777));
        expect(yield* mode(executableName)).toBe(0o755);
        expect(yield* mode("libEGL.so")).toBe(0o755);
        expect(yield* mode(path.join("locales", "en-US.pak"))).toBe(0o644);
      }
      expect((yield* fs.readDirectory(installRoot)).toSorted()).toEqual([
        ".install-other",
        "1.2.3",
      ]);
      expect(yield* browser.executable).toBe(executable);
      expect(yield* browser.installed).toEqual(Option.some(executable));
      expect(requests).toHaveLength(1);
    }),
  );

  it.effect.each([
    { name: "a hash mismatch", sha256: "0".repeat(64) },
    { name: "a short download", body: Stream.make(browserArchive.subarray(0, -1)) },
    {
      name: "an oversized download",
      body: Stream.make(browserArchive, Buffer.from("extra")),
    },
  ])("rejects $name, installs nothing, and retries on the next call", (testCase) =>
    Effect.gen(function* () {
      const { browser, fs, installRoot, requests } = yield* makeHarness(testCase);

      const error = yield* browser.executable.pipe(Effect.flip);

      expect(error._tag).toBe("PreviewBrowserInstallError");
      expect(error.message).toMatch(
        /^GOAT could not install its headless browser: .+ Try again\.$/,
      );
      expect(yield* fs.readDirectory(installRoot)).toEqual([]);
      yield* browser.executable.pipe(Effect.flip);
      expect(requests).toHaveLength(2);
    }),
  );

  it.effect.each([
    { name: "a parent-directory entry", entry: `${ROOT}../escape` },
    { name: "an absolute entry", entry: "/escape" },
    { name: "an entry outside the top directory", entry: "escape" },
  ])("rejects an archive with $name", (testCase) =>
    Effect.gen(function* () {
      const { browser, fs, path, baseDir, installRoot } = yield* makeHarness({
        archive: makeZip([
          { name: `${ROOT}${executableName}`, data: "#!/bin/sh\n", mode: 0o100755 },
          { name: testCase.entry, data: "escaped", mode: 0o100644 },
        ]),
      });

      const error = yield* browser.executable.pipe(Effect.flip);

      expect(error._tag).toBe("PreviewBrowserInstallError");
      expect(yield* fs.readDirectory(installRoot)).toEqual([]);
      expect(yield* fs.exists(path.join(baseDir, "tools", "chrome-headless-shell", "escape"))).toBe(
        false,
      );
    }),
  );

  it.effect(
    "uses a runnable custom executable override without downloading, even on unsupported platforms",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const customDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-custom-browser-" });
        const customBin = path.join(customDir, executableName);
        yield* fs.writeFileString(customBin, "#!/bin/sh\n");
        if (hostPlatform !== "win32") yield* fs.chmod(customBin, 0o755);

        const { browser, requests } = yield* makeHarness({
          unsupported: true,
          env: { GOAT_SERVER_BROWSER_EXECUTABLE_PATH: `  ${customBin}  ` },
        });

        expect(yield* browser.installed).toEqual(Option.some(customBin));
        expect(yield* browser.executable).toBe(customBin);
        expect(requests).toEqual([]);
      }),
  );

  it.effect("fails when a custom executable override is missing or not executable", () =>
    Effect.gen(function* () {
      const { browser, requests } = yield* makeHarness({
        executablePath: "/nonexistent/custom-chrome",
      });

      expect(yield* browser.installed).toEqual(Option.none());
      const error = yield* browser.executable.pipe(Effect.flip);
      expect(error._tag).toBe("PreviewBrowserInstallError");
      expect(error.message).toContain("/nonexistent/custom-chrome");
      expect(requests).toEqual([]);
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "unpacks full Chrome app bundle archives with relative symlinks into tools/chrome",
    () =>
      Effect.gen(function* () {
        const appExe = "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
        const fwRoot =
          "Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/";
        const chromeZip = makeZip([
          { name: "chrome-fixture/", mode: 0o40755 },
          { name: `chrome-fixture/${appExe}`, data: "#!/bin/sh\n", mode: 0o100755 },
          {
            name: `chrome-fixture/${fwRoot}Versions/1.2.3/Resources/Info.plist`,
            data: "<plist/>",
            mode: 0o100644,
          },
          {
            name: `chrome-fixture/${fwRoot}Versions/Current`,
            data: "1.2.3",
            mode: 0o120755,
          },
          {
            name: `chrome-fixture/${fwRoot}Resources`,
            data: "Versions/Current/Resources",
            mode: 0o120755,
          },
        ]);
        const crypto = yield* Crypto.Crypto;
        const sha256 = Hex.encode(yield* crypto.digest("SHA-256", chromeZip).pipe(Effect.orDie));
        const { browser, fs, path, baseDir, installRoot } = yield* makeHarness({
          variant: "chrome",
          archive: chromeZip,
          release: {
            version: "1.2.3",
            platform: "fixture",
            url: "https://storage.googleapis.com/chrome-fixture.zip",
            bytes: chromeZip.byteLength,
            sha256,
            rootDir: "chrome-fixture/",
            executablePath: appExe,
          },
        });

        const executable = yield* browser.executable;
        expect(installRoot).toBe(path.join(baseDir, "tools", "chrome", "fixture"));
        expect(executable).toBe(path.join(installRoot, "1.2.3", ...appExe.split("/")));
        expect(
          yield* fs.readFileString(
            path.join(installRoot, "1.2.3", ...`${fwRoot}Resources/Info.plist`.split("/")),
          ),
        ).toBe("<plist/>");
      }),
  );

  it.effect.each([
    {
      name: "a relative symlink escaping the destination",
      entries: [
        { name: `${ROOT}${executableName}`, data: "#!/bin/sh\n", mode: 0o100755 },
        { name: `${ROOT}escape-link`, data: "../../escape", mode: 0o120755 },
      ],
    },
    {
      name: "a chained ancestor symlink escape",
      entries: [
        { name: `${ROOT}${executableName}`, data: "#!/bin/sh\n", mode: 0o100755 },
        { name: `${ROOT}a/b/c/dir_link`, data: "../..", mode: 0o120755 },
        { name: `${ROOT}a/b/c/dir_link/escape`, data: "../../..", mode: 0o120755 },
      ],
    },
  ])("rejects an archive with $name", (testCase) =>
    Effect.gen(function* () {
      const { browser, fs, installRoot } = yield* makeHarness({
        archive: makeZip(testCase.entries),
      });

      const error = yield* browser.executable.pipe(Effect.flip);
      expect(error._tag).toBe("PreviewBrowserInstallError");
      expect(yield* fs.readDirectory(installRoot)).toEqual([]);
    }),
  );
});
