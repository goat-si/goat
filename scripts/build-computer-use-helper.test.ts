// @effect-diagnostics nodeBuiltinImport:off -- Reads the checked-in Info.plist template the build renders.
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Exit from "effect/Exit";
import { Command } from "effect/cli";

import {
  AD_HOC_WARNING,
  buildComputerUseHelperCommand,
  chooseSigningIdentity,
  compileComputerUseLauncher,
  helperBundleIdForChannel,
  helperDesignatedRequirement,
  renderHelperInfoPlist,
  resolveSigningIdentity,
  signComputerUseHelper,
  stageComputerUseDriver,
} from "./build-computer-use-helper.ts";
import {
  runReleaseCommand,
  type CommandResult,
  type ReleaseCommandRunner,
} from "./lib/release-verify.ts";
import { packagedHelperChannel } from "./lib/desktop-computer-use-helper.ts";

const helperDir = NodePath.join(import.meta.dirname, "../apps/desktop/native/computer-use-helper");
const macWithSwift =
  HostProcess.Platform.defaultValue() === "darwin" &&
  NodeChildProcess.spawnSync("xcrun", ["--find", "swiftc"], { encoding: "utf8" }).status === 0;

const FIND_IDENTITY = [
  '  1) D92256BFF6CC21ABD4275A89CA418AAF8B484B00 "Apple Development: Someone (QQ4ZRC9P5J)"',
  '  2) 94E152BFF6CC21ABD4275A89CA418AAF8B484B99 "Developer ID Application: Someone (U9ATA49N28)"',
  "     2 valid identities found",
].join("\n");
const NONE = "     0 valid identities found";

/** Answers each command from `answer` and records the calls, like the build's real runner. */
function fakeRunner(answer: (program: string, args: readonly string[]) => Partial<CommandResult>) {
  const calls: Array<readonly string[]> = [];
  const runner: ReleaseCommandRunner = (program, args) => {
    calls.push([program, ...args]);
    return Effect.succeed({ exitCode: 0, stdout: "", stderr: "", ...answer(program, args) });
  };
  return { runner, calls };
}

const SIGN_INPUT = {
  bundle: "/out/GOAT Computer Use.app",
  bundleId: "si.goat.desktop.dev.computer-use",
  driverPaths: ["/out/driver/cua-driver"],
  entitlements: "/src/entitlements.plist",
};

describe("build-computer-use-helper", () => {
  it.effect.skipIf(!macWithSwift)(
    "builds matching launcher and driver slices and rejects missing architectures",
    () =>
      Effect.gen(function* () {
        const dir = NodeFS.mkdtempSync(
          NodePath.join(NodeFS.realpathSync(NodeOS.tmpdir()), "goat-arch-"),
        );
        try {
          const source = NodePath.join(dir, "main.swift");
          const universal = NodePath.join(dir, "universal");
          NodeFS.writeFileSync(source, 'print("helper")\n');
          const command = (program: string, args: string[]) => {
            const result = NodeChildProcess.spawnSync(program, args, { encoding: "utf8" });
            assert.strictEqual(result.status, 0, result.stderr);
            return result.stdout.trim();
          };
          yield* compileComputerUseLauncher(
            [source],
            universal,
            dir,
            "universal",
            runReleaseCommand,
          );
          const slices = (executable: string) =>
            new Set(command("lipo", ["-archs", executable]).split(/\s+/u));
          const stage = (src: string, dest: string, arch: "arm64" | "x64" | "universal") =>
            stageComputerUseDriver(src, dest, arch, runReleaseCommand);
          for (const [arch, expected] of [
            ["arm64", "arm64"],
            ["x64", "x86_64"],
          ] as const) {
            const dest = NodePath.join(dir, arch);
            yield* stage(universal, dest, arch);
            const launcher = NodePath.join(dir, "launcher-" + arch);
            yield* compileComputerUseLauncher([source], launcher, dir, arch, runReleaseCommand);
            assert.deepEqual(slices(dest), new Set([expected]));
            assert.deepEqual(slices(launcher), new Set([expected]));
          }
          const output = NodePath.join(dir, "both");
          yield* stage(universal, output, "universal");
          assert.deepEqual(slices(output), new Set(["arm64", "x86_64"]));
          assert.deepEqual(slices(universal), slices(output));
          assert.isTrue(
            Exit.isFailure(yield* Effect.exit(stage(NodePath.join(dir, "arm64"), output, "x64"))),
          );
          assert.isTrue(
            Exit.isFailure(
              yield* Effect.exit(stage(NodePath.join(dir, "arm64"), output, "universal")),
            ),
          );
        } finally {
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.skipIf(!macWithSwift)(
    "typechecks the complete native helper with its macOS deployment target",
    () => {
      const sources = NodeFS.readdirSync(helperDir)
        .filter((file) => file.endsWith(".swift"))
        .map((file) => NodePath.join(helperDir, file));
      const result = NodeChildProcess.spawnSync(
        "xcrun",
        [
          "swiftc",
          "-typecheck",
          "-target",
          `${HostProcess.Architecture.defaultValue() === "arm64" ? "arm64" : "x86_64"}-apple-macos13.0`,
          ...sources,
        ],
        { encoding: "utf8" },
      );
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    },
  );

  it.effect("parses a default build without --ad-hoc (#1349)", () =>
    Effect.gen(function* () {
      // Off macOS the build stops at its platform check, so reaching it proves the flags parsed.
      const exit = yield* Effect.exit(
        Command.runWith(buildComputerUseHelperCommand, { version: "0.0.0" })(["--channel", "dev"]),
      );
      const message = String(Exit.isFailure(exit) ? exit.cause : "");
      assert.include(message, "The helper builds on macOS only.");
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect.each([
    ["arm64", "arm64"],
    ["x64", "x86_64"],
    ["universal", null],
  ] as const)("stages the driver for %s", ([arch, slice]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const source = NodePath.join(directory, "source");
      const destination = NodePath.join(directory, "driver");
      yield* fs.writeFileString(source, "verified release");
      const calls: Array<readonly string[]> = [];
      const runner: ReleaseCommandRunner = (program, args) =>
        Effect.gen(function* () {
          calls.push([program, ...args]);
          yield* fs.writeFileString(destination, "selected slice").pipe(Effect.orDie);
          return { exitCode: 0, stdout: "", stderr: "" };
        });
      yield* stageComputerUseDriver(source, destination, arch, runner);
      assert.deepEqual(
        calls,
        slice
          ? [["lipo", source, "-thin", slice, "-output", destination]]
          : [
              ["lipo", source, "-verify_arch", "arm64"],
              ["lipo", source, "-verify_arch", "x86_64"],
            ],
      );
      assert.equal(yield* fs.readFileString(source), "verified release");
      assert.equal(
        yield* fs.readFileString(destination),
        slice ? "selected slice" : "verified release",
      );
      if (HostProcess.Platform.defaultValue() !== "win32") {
        const mode = (yield* fs.stat(destination)).mode;
        assert.strictEqual(mode & 0o777, 0o755);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("signs every channel, dev included, with the keychain's Developer ID and its team", () => {
    for (const channel of ["stable", "nightly", "dev"] as const)
      assert.deepEqual(
        chooseSigningIdentity({
          channel,
          explicit: undefined,
          adHoc: false,
          findIdentityOutput: FIND_IDENTITY,
        }),
        { identity: "Developer ID Application: Someone (U9ATA49N28)", team: "U9ATA49N28" },
      );
  });

  it("fails instead of falling back to ad-hoc when no Developer ID is usable (#1333)", () => {
    for (const channel of ["stable", "nightly", "dev"] as const) {
      const choice = chooseSigningIdentity({
        channel,
        explicit: undefined,
        adHoc: false,
        findIdentityOutput: NONE,
      });
      assert.property(choice, "error");
      if ("error" in choice) {
        assert.include(choice.error, "Run the build from Terminal while signed in");
        assert.equal(choice.error.includes("--ad-hoc"), channel === "dev");
      }
    }
  });

  it("signs ad-hoc only with --ad-hoc on the dev channel, and warns about lost grants", () => {
    assert.deepEqual(
      chooseSigningIdentity({
        channel: "dev",
        explicit: undefined,
        adHoc: true,
        findIdentityOutput: FIND_IDENTITY,
      }),
      { identity: "-", warning: AD_HOC_WARNING },
    );
    assert.include(AD_HOC_WARNING, "both lists");
    // `--identity -` used to mean ad-hoc; it now has to be asked for by name.
    assert.property(
      chooseSigningIdentity({
        channel: "dev",
        explicit: "-",
        adHoc: false,
        findIdentityOutput: FIND_IDENTITY,
      }),
      "error",
    );
    for (const channel of ["stable", "nightly"] as const)
      assert.property(
        chooseSigningIdentity({
          channel,
          explicit: undefined,
          adHoc: true,
          findIdentityOutput: NONE,
        }),
        "error",
      );
    assert.property(
      chooseSigningIdentity({
        channel: "dev",
        explicit: "Developer ID Application: Someone (U9ATA49N28)",
        adHoc: true,
        findIdentityOutput: FIND_IDENTITY,
      }),
      "error",
    );
    // An unsigned local GOAT.app has no team either, so the helper it embeds may be ad-hoc.
    for (const channel of ["stable", "nightly"] as const)
      assert.deepEqual(
        chooseSigningIdentity({
          channel,
          explicit: undefined,
          adHoc: true,
          unsignedPackage: true,
          findIdentityOutput: NONE,
        }),
        { identity: "-", warning: AD_HOC_WARNING },
      );
  });

  it("accepts an explicit identity only when it is a Developer ID in this keychain", () => {
    // An explicit certificate must still be a Developer ID from this keychain.
    for (const channel of ["stable", "dev"] as const)
      assert.property(
        chooseSigningIdentity({
          channel,
          explicit: "Apple Development: Someone (QQ4ZRC9P5J)",
          adHoc: false,
          findIdentityOutput: FIND_IDENTITY,
        }),
        "error",
      );
    assert.deepEqual(
      chooseSigningIdentity({
        channel: "nightly",
        explicit: "94e152bff6cc21abd4275a89ca418aaf8b484b99",
        adHoc: false,
        findIdentityOutput: FIND_IDENTITY,
      }),
      { identity: "94e152bff6cc21abd4275a89ca418aaf8b484b99", team: "U9ATA49N28" },
    );
  });

  it("pins grants to bundle id and team, so a rebuild satisfies the same requirement", () => {
    const requirement = helperDesignatedRequirement(
      "si.goat.desktop.dev.computer-use",
      "U9ATA49N28",
    );
    assert.match(requirement, /^=designated => identifier "si\.goat\.desktop\.dev\.computer-use" /);
    assert.include(requirement, 'certificate leaf[subject.OU] = "U9ATA49N28"');
    assert.notInclude(requirement, "cdhash");
  });

  it.effect("reports a failed keychain lookup with its own error instead of 'no identity'", () =>
    Effect.gen(function* () {
      const { runner, calls } = fakeRunner(() => ({
        exitCode: 1,
        stderr: "security: SecKeychainSearchCopyNext: User interaction is not allowed.",
      }));
      const exit = yield* Effect.exit(
        resolveSigningIdentity(runner, { channel: "dev", identity: undefined, adHoc: false }),
      );
      assert.isTrue(Exit.isFailure(exit));
      const message = String(Exit.isFailure(exit) ? exit.cause : "");
      assert.include(message, "User interaction is not allowed");
      assert.include(message, "Run the build from Terminal while signed in");
      assert.lengthOf(calls, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("signs drivers, then the bundle under the team requirement, then verifies", () =>
    Effect.gen(function* () {
      const { runner, calls } = fakeRunner(() => ({}));
      yield* signComputerUseHelper(runner, {
        ...SIGN_INPUT,
        choice: { identity: "Developer ID Application: Someone (U9ATA49N28)", team: "U9ATA49N28" },
      });
      assert.deepEqual(
        calls.map((call) => call.at(-1)),
        ["/out/driver/cua-driver", SIGN_INPUT.bundle, SIGN_INPUT.bundle],
      );
      const bundleSign = calls[1] ?? [];
      assert.include(bundleSign, "--timestamp");
      assert.include(bundleSign, "runtime");
      assert.equal(
        bundleSign[bundleSign.indexOf("--requirements") + 1],
        helperDesignatedRequirement(SIGN_INPUT.bundleId, "U9ATA49N28"),
      );
      assert.include(calls[2] ?? [], "--verify");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("stops on a codesign failure with the keychain remedy and never retries ad-hoc", () =>
    Effect.gen(function* () {
      const { runner, calls } = fakeRunner((_, args) =>
        args.at(-1) === SIGN_INPUT.bundle
          ? { exitCode: 1, stderr: SIGN_INPUT.bundle + ": errSecInternalComponent" }
          : {},
      );
      const exit = yield* Effect.exit(
        signComputerUseHelper(runner, {
          ...SIGN_INPUT,
          choice: {
            identity: "Developer ID Application: Someone (U9ATA49N28)",
            team: "U9ATA49N28",
          },
        }),
      );
      assert.isTrue(Exit.isFailure(exit));
      const message = String(Exit.isFailure(exit) ? exit.cause : "");
      assert.include(message, "errSecInternalComponent");
      assert.include(message, "not usable from this session");
      assert.lengthOf(calls, 2);
      assert.isFalse(calls.some((call) => call.includes("-")));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("lets only dev and ad-hoc helpers serve any parent, under per-channel bundle ids", () => {
    const template = NodeFS.readFileSync(
      new URL("../apps/desktop/native/computer-use-helper/Info.plist", import.meta.url),
      "utf8",
    );
    const render = (channel: "stable" | "nightly" | "dev", allowAnyParent = channel === "dev") =>
      renderHelperInfoPlist(template, {
        bundleId: helperBundleIdForChannel(channel),
        version: "1.2.3",
        allowAnyParent,
      });
    for (const channel of ["stable", "nightly", "dev"] as const)
      assert.notMatch(render(channel), /@[A-Z_]+@/);
    assert.match(render("stable"), /<string>si\.goat\.desktop\.computer-use<\/string>/);
    assert.match(render("nightly"), /<string>si\.goat\.desktop\.nightly\.computer-use<\/string>/);
    // Only a dev helper may skip its parent check; a nightly or stable one never does.
    for (const channel of ["stable", "nightly"] as const)
      assert.match(render(channel), /GOATComputerUseAllowAnyParent<\/key>\s*<false\/>/);
    assert.match(render("dev"), /GOATComputerUseAllowAnyParent<\/key>\s*<true\/>/);
    assert.match(render("stable", true), /GOATComputerUseAllowAnyParent<\/key>\s*<true\/>/);
  });

  it("a packaged app never embeds the dev helper, which skips its parent check", () => {
    assert.strictEqual(packagedHelperChannel("nightly"), "nightly");
    assert.strictEqual(packagedHelperChannel("latest"), "stable");
  });
});
