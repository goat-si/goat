import { assert, describe, it } from "@effect/vitest";

import { renderWindowsBuildInfo, windowsSigningPlan } from "./build-computer-use-helper-windows.ts";

const PIN = { file: "cua-driver.exe", sha256: "a".repeat(64) };

describe("build-computer-use-helper-windows", () => {
  it("builds unsigned dev and nightly helpers, and leaves a stable one to the packaging job", () => {
    for (const channel of ["dev", "nightly"] as const)
      assert.deepEqual(
        windowsSigningPlan({ channel, thumbprint: undefined, timestampUrl: undefined }),
        { sign: false },
      );
    assert.property(
      windowsSigningPlan({ channel: "stable", thumbprint: undefined, timestampUrl: undefined }),
      "error",
    );
    assert.deepEqual(
      windowsSigningPlan({
        channel: "stable",
        thumbprint: undefined,
        timestampUrl: undefined,
        allowAnyParent: true,
      }),
      { sign: false },
    );
    assert.deepEqual(
      windowsSigningPlan({
        channel: "stable",
        thumbprint: undefined,
        timestampUrl: undefined,
        deferredSigning: true,
      }),
      { sign: false },
    );
    assert.property(
      windowsSigningPlan({
        channel: "stable",
        thumbprint: "not-a-thumbprint",
        timestampUrl: undefined,
      }),
      "error",
    );
    const plan = windowsSigningPlan({
      channel: "stable",
      thumbprint: "94e152bff6cc21abd4275a89ca418aaf8b484b99",
      timestampUrl: "http://timestamp.example",
    });
    assert.deepEqual("args" in plan ? plan.args.slice(0, 3) : [], [
      "sign",
      "/sha1",
      "94E152BFF6CC21ABD4275A89CA418AAF8B484B99",
    ]);
  });

  it("lets only a dev helper serve any parent, and names each channel's GOAT executable", () => {
    const dev = renderWindowsBuildInfo({ channel: "dev", version: "0.1.2", pins: [PIN] });
    const nightly = renderWindowsBuildInfo({
      channel: "nightly",
      version: "0.1.2-nightly.1",
      pins: [PIN],
    });
    assert.include(dev, "AllowAnyParent = true;");
    assert.include(dev, '"si.goat.desktop.dev.computer-use"');
    assert.include(nightly, "AllowAnyParent = false;");
    assert.include(nightly, 'ParentExecutable = "GOAT (Nightly).exe";');
    // An unsigned channel has no signature to check a parent against.
    assert.include(
      renderWindowsBuildInfo({
        channel: "nightly",
        version: "0.1.2-nightly.1",
        pins: [PIN],
        allowAnyParent: true,
      }),
      "AllowAnyParent = true;",
    );
    assert.include(
      renderWindowsBuildInfo({
        channel: "stable",
        version: "0.1.2",
        pins: [PIN],
        allowAnyParent: false,
      }),
      "AllowAnyParent = false;",
    );
    assert.include(
      nightly,
      'new KeyValuePair<string, string>("cua-driver.exe", "' + PIN.sha256 + '")',
    );
  });

  it("refuses a pin that is not a lowercase SHA-256 of a plain file name", () => {
    for (const pin of [
      { file: "cua-driver.exe", sha256: "A".repeat(64) },
      { file: "..\\cua-driver.exe", sha256: "a".repeat(64) },
      { file: 'x");', sha256: "a".repeat(64) },
    ])
      assert.throws(() =>
        renderWindowsBuildInfo({ channel: "dev", version: "1.0.0", pins: [pin] }),
      );
  });
});
