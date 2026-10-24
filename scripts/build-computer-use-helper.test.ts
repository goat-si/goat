// @effect-diagnostics nodeBuiltinImport:off -- Reads the checked-in Info.plist template the build renders.
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";

import {
  AD_HOC_WARNING,
  chooseSigningIdentity,
  helperBundleIdForChannel,
  helperDesignatedRequirement,
  renderHelperInfoPlist,
  signingFailure,
} from "./build-computer-use-helper.ts";

const FIND_IDENTITY = [
  '  1) D92256BFF6CC21ABD4275A89CA418AAF8B484B00 "Apple Development: Someone (QQ4ZRC9P5J)"',
  '  2) 94E152BFF6CC21ABD4275A89CA418AAF8B484B99 "Developer ID Application: Someone (U9ATA49N28)"',
  "     2 valid identities found",
].join("\n");
const NONE = "     0 valid identities found";

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

  it("explains a keychain the session cannot use when codesign fails", () => {
    const message = signingFailure(
      "/tmp/GOAT Computer Use.app",
      "/tmp/GOAT Computer Use.app: errSecInternalComponent\n",
    );
    assert.include(message, "errSecInternalComponent");
    assert.include(message, "not usable from this session");
    assert.include(message, "Always Allow");
    assert.include(message, "does not fall back to ad-hoc");
  });

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
