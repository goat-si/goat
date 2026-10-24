// @effect-diagnostics nodeBuiltinImport:off -- Reads the checked-in Info.plist template the build renders.
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  AD_HOC_WARNING,
  chooseSigningIdentity,
  helperBundleIdForChannel,
  helperDesignatedRequirement,
  renderHelperInfoPlist,
  resolveSigningIdentity,
  signComputerUseHelper,
} from "./build-computer-use-helper.ts";
import type { CommandResult, ReleaseCommandRunner } from "./lib/release-verify.ts";

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
    }),
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
    }),
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
    }),
  );

  it("lets only a dev helper serve any parent, under its own per-channel bundle id", () => {
    const template = NodeFS.readFileSync(
      new URL("../apps/desktop/native/computer-use-helper/Info.plist", import.meta.url),
      "utf8",
    );
    const render = (channel: "stable" | "nightly" | "dev") =>
      renderHelperInfoPlist(template, {
        bundleId: helperBundleIdForChannel(channel),
        version: "1.2.3",
        channel,
      });
    for (const channel of ["stable", "nightly", "dev"] as const)
      assert.notMatch(render(channel), /@[A-Z_]+@/);
    assert.match(render("stable"), /<string>si\.goat\.desktop\.computer-use<\/string>/);
    assert.match(render("nightly"), /<string>si\.goat\.desktop\.nightly\.computer-use<\/string>/);
    assert.match(render("stable"), /GOATComputerUseAllowAnyParent<\/key>\s*<false\/>/);
    assert.match(render("dev"), /GOATComputerUseAllowAnyParent<\/key>\s*<true\/>/);
  });
});
