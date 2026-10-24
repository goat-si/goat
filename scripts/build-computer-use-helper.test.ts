// @effect-diagnostics nodeBuiltinImport:off -- Reads the checked-in Info.plist template the build renders.
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";

import {
  chooseSigningIdentity,
  helperBundleIdForChannel,
  renderHelperInfoPlist,
} from "./build-computer-use-helper.ts";

const FIND_IDENTITY = [
  '  1) D92256BFF6CC21ABD4275A89CA418AAF8B484B00 "Apple Development: Someone (QQ4ZRC9P5J)"',
  '  2) 94E152BFF6CC21ABD4275A89CA418AAF8B484B99 "Developer ID Application: Someone (U9ATA49N28)"',
  "     2 valid identities found",
].join("\n");

describe("build-computer-use-helper", () => {
  it("signs with the keychain's Developer ID unless an identity is given", () => {
    assert.deepEqual(
      chooseSigningIdentity({
        channel: "stable",
        explicit: undefined,
        findIdentityOutput: FIND_IDENTITY,
      }),
      { identity: "Developer ID Application: Someone (U9ATA49N28)" },
    );
    assert.deepEqual(
      chooseSigningIdentity({ channel: "dev", explicit: "-", findIdentityOutput: FIND_IDENTITY }),
      { identity: "-" },
    );
  });

  it("refuses an ad-hoc release helper, which could not verify its parent's team", () => {
    const none = "     0 valid identities found";
    assert.deepEqual(
      chooseSigningIdentity({ channel: "dev", explicit: undefined, findIdentityOutput: none }),
      {
        identity: "-",
      },
    );
    for (const channel of ["stable", "nightly"] as const)
      assert.property(
        chooseSigningIdentity({ channel, explicit: undefined, findIdentityOutput: none }),
        "error",
      );
    // An explicit certificate must still be a Developer ID from this keychain.
    assert.property(
      chooseSigningIdentity({
        channel: "stable",
        explicit: "Apple Development: Someone (QQ4ZRC9P5J)",
        findIdentityOutput: FIND_IDENTITY,
      }),
      "error",
    );
    assert.deepEqual(
      chooseSigningIdentity({
        channel: "nightly",
        explicit: "94e152bff6cc21abd4275a89ca418aaf8b484b99",
        findIdentityOutput: FIND_IDENTITY,
      }),
      { identity: "94e152bff6cc21abd4275a89ca418aaf8b484b99" },
    );
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
