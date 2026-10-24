import { assert, describe, it } from "@effect/vitest";

import {
  computerUseHelperRefusal,
  embeddedHelperProblems,
  signedComputerUseHelper,
  withComputerUseHelper,
} from "./desktop-artifact-computer-use.ts";

const signed = {
  bundle: "/stage/computer-use-helper/GOAT Computer Use.app",
  bundleId: "si.goat.desktop.computer-use",
  signed: true,
};

describe("desktop computer use payload", () => {
  it("keeps the flag to unsigned arm64 and x64 mac builds; signed ones always carry the helper", () => {
    assert.isUndefined(computerUseHelperRefusal({ platform: "mac", arch: "arm64", signed: false }));
    assert.isUndefined(computerUseHelperRefusal({ platform: "mac", arch: "x64", signed: false }));
    assert.match(
      computerUseHelperRefusal({ platform: "mac", arch: "arm64", signed: true }) ?? "",
      /always carries the Developer ID helper/,
    );
    assert.isDefined(
      computerUseHelperRefusal({ platform: "mac", arch: "universal", signed: false }),
    );
    assert.isDefined(computerUseHelperRefusal({ platform: "win", arch: "x64", signed: false }));
  });

  it("fails a build whose helper was re-signed or signed by another team than GOAT.app", () => {
    const built = { cdhash: "aa11" };
    const app = { team: "U9ATA49N28" };
    assert.deepEqual(
      embeddedHelperProblems({
        helper: signed,
        built,
        embedded: { cdhash: "aa11", team: "U9ATA49N28" },
        app,
      }),
      [],
    );
    assert.lengthOf(
      embeddedHelperProblems({
        helper: signed,
        built,
        embedded: { cdhash: "bb22", team: "U9ATA49N28" },
        app,
      }),
      1,
    );
    assert.match(
      embeddedHelperProblems({
        helper: signed,
        built,
        embedded: { cdhash: "aa11", team: "OTHERTEAM1" },
        app,
      }).join(" "),
      /would refuse its parent/,
    );
    // An ad-hoc helper in an ad-hoc GOAT.app has no team on either side, and nothing else is.
    const adHoc = { ...signed, signed: false };
    assert.deepEqual(
      embeddedHelperProblems({
        helper: adHoc,
        built,
        embedded: { cdhash: "aa11", team: undefined },
        app: { team: undefined },
      }),
      [],
    );
    // electron-builder picked a real certificate for GOAT.app around an any-parent helper.
    assert.lengthOf(
      embeddedHelperProblems({
        helper: adHoc,
        built,
        embedded: { cdhash: "aa11", team: undefined },
        app,
      }),
      1,
    );
  });

  it("keeps GOAT.app's signer off the helper createBuildConfig places in Contents/Helpers", () => {
    const helper = signedComputerUseHelper(
      "/stage/computer-use-helper/GOAT Computer Use.app",
      "si.goat.desktop.nightly",
    );
    assert.deepEqual(helper, {
      bundle: "/stage/computer-use-helper/GOAT Computer Use.app",
      bundleId: "si.goat.desktop.nightly.computer-use",
      signed: true,
    });
    assert.isUndefined(signedComputerUseHelper(undefined, "si.goat.desktop"));
    const sign = "/repo/scripts/sign-macos.ts";
    const config = withComputerUseHelper({ appId: "si.goat.desktop", mac: { sign } }, helper);
    const mac = config.mac as { signIgnore: string[]; sign: string };
    // A signed build keeps its own signer and identity; only the helper is left alone.
    assert.equal(mac.sign, sign);
    assert.notProperty(mac, "identity");
    const ignored = (file: string) =>
      mac.signIgnore.some((pattern) => new RegExp(pattern).test(file));
    const contents = "/dist/mac-arm64/GOAT.app/Contents";
    // createBuildConfig's extraResources entry "../Helpers/GOAT Computer Use.app", from Contents/Resources.
    const placed = contents + "/Helpers/GOAT Computer Use.app";
    assert.isTrue(ignored(placed));
    assert.isTrue(ignored(placed + "/Contents/Resources/cua-driver/cua-driver"));
    assert.isFalse(ignored(contents + "/Frameworks/GOAT Helper (Renderer).app"));
    assert.isFalse(ignored(contents + "/Helpers/GOAT Computer Use Extra.app"));
    assert.isFalse(ignored("/dist/mac-arm64/GOAT.app"));

    const adHoc = withComputerUseHelper({ mac: {} }, { ...signed, signed: false });
    assert.propertyVal(adHoc.mac, "identity", "-");
    assert.propertyVal(adHoc.mac, "notarize", false);
    assert.match(String((adHoc.mac as { sign: string }).sign), /sign-macos-ad-hoc\.ts$/);
    assert.strictEqual(withComputerUseHelper(config, undefined), config);
  });
});
