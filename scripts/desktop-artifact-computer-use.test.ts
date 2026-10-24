import { assert, describe, it } from "@effect/vitest";

import {
  COMPUTER_USE_HELPER_IN_APP,
  computerUseHelperRefusal,
  embeddedHelperProblems,
  withComputerUseHelper,
} from "./desktop-artifact-computer-use.ts";

const signed = {
  bundle: "/stage/computer-use-helper/GOAT Computer Use.app",
  bundleId: "si.goat.desktop.computer-use",
  signed: true,
};

describe("desktop computer use payload", () => {
  it("refuses signed, universal and non-mac builds until each can carry the helper intact", () => {
    assert.isUndefined(computerUseHelperRefusal({ platform: "mac", arch: "arm64", signed: false }));
    assert.isUndefined(computerUseHelperRefusal({ platform: "mac", arch: "x64", signed: false }));
    assert.match(
      computerUseHelperRefusal({ platform: "mac", arch: "arm64", signed: true }) ?? "",
      /#1210/,
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

  it("puts the helper where the desktop host looks and keeps GOAT.app's signer off it", () => {
    const config = withComputerUseHelper(
      { appId: "si.goat.desktop", mac: { icon: "icon.icns" } },
      signed,
    );
    const mac = config.mac as {
      extraFiles: Array<{ from: string; to: string }>;
      signIgnore: string[];
      icon: string;
    };
    assert.equal(mac.icon, "icon.icns");
    // DesktopCuaDriver resolves <Contents/Resources>/../Helpers/GOAT Computer Use.app.
    assert.deepEqual(mac.extraFiles, [{ from: signed.bundle, to: COMPUTER_USE_HELPER_IN_APP }]);
    assert.equal(COMPUTER_USE_HELPER_IN_APP, "Helpers/GOAT Computer Use.app");
    assert.notProperty(mac, "identity");
    const ignored = (file: string) =>
      mac.signIgnore.some((pattern) => new RegExp(pattern).test(file));
    const app = "/dist/mac-arm64/GOAT.app/Contents";
    assert.isTrue(ignored(app + "/Helpers/GOAT Computer Use.app"));
    assert.isTrue(
      ignored(app + "/Helpers/GOAT Computer Use.app/Contents/Resources/cua-driver/cua-driver"),
    );
    assert.isFalse(ignored(app + "/Frameworks/GOAT Helper (Renderer).app"));
    assert.isFalse(ignored(app + "/Helpers/GOAT Computer Use Extra.app"));
    assert.isFalse(ignored("/dist/mac-arm64/GOAT.app"));

    const adHoc = withComputerUseHelper({ mac: {} }, { ...signed, signed: false });
    assert.propertyVal(adHoc.mac, "identity", "-");
    assert.match(String((adHoc.mac as { sign: string }).sign), /sign-macos-ad-hoc\.ts$/);
    assert.strictEqual(withComputerUseHelper(config, undefined), config);
  });
});
