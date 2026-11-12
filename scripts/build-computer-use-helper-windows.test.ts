import { assert, describe, it } from "@effect/vitest";

import { renderWindowsBuildInfo, windowsSigningPlan } from "./build-computer-use-helper-windows.ts";

const PIN = { file: "cua-driver.exe", sha256: "a".repeat(64) };

describe("build-computer-use-helper-windows", () => {
  it("builds unsigned dev, nightly and preview helpers, and leaves a stable one to the packaging job", () => {
    for (const channel of ["dev", "nightly", "preview"] as const)
      assert.deepEqual(
        windowsSigningPlan({ channel, thumbprint: undefined, timestampUrl: undefined }),
        { sign: false, allowAnyParent: true },
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
      { sign: false, allowAnyParent: true },
    );
    assert.deepEqual(
      windowsSigningPlan({
        channel: "stable",
        thumbprint: undefined,
        timestampUrl: undefined,
        deferredSigning: true,
      }),
      { sign: false, allowAnyParent: false },
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
    // A signed helper checks the publisher that started it, so it never serves any parent.
    assert.isFalse("allowAnyParent" in plan ? plan.allowAnyParent : true);
  });

  it("refuses a helper that would be signed and serve any parent", () => {
    assert.property(
      windowsSigningPlan({
        channel: "nightly",
        thumbprint: undefined,
        timestampUrl: undefined,
        deferredSigning: true,
        allowAnyParent: true,
      }),
      "error",
    );
    assert.property(
      windowsSigningPlan({
        channel: "nightly",
        thumbprint: "94e152bff6cc21abd4275a89ca418aaf8b484b99",
        timestampUrl: undefined,
        allowAnyParent: true,
      }),
      "error",
    );
  });

  it("names each channel's GOAT executable and helper identity", () => {
    const dev = renderWindowsBuildInfo({
      channel: "dev",
      version: "0.1.2",
      pins: [PIN],
      allowAnyParent: true,
    });
    const nightly = renderWindowsBuildInfo({
      channel: "nightly",
      version: "0.1.2-nightly.1",
      pins: [PIN],
      allowAnyParent: false,
    });
    assert.include(dev, "AllowAnyParent = true;");
    assert.include(dev, '"si.goat.desktop.dev.computer-use"');
    assert.include(nightly, "AllowAnyParent = false;");
    assert.include(nightly, 'ParentExecutable = "GOAT (Nightly).exe";');
    assert.include(nightly, '"si.goat.desktop.nightly.computer-use"');
    // A preview runs the nightly helper but ships stable's product name.
    const preview = renderWindowsBuildInfo({
      channel: "preview",
      version: "0.1.2-preview.20260101.1",
      pins: [PIN],
      allowAnyParent: true,
    });
    assert.include(preview, '"si.goat.desktop.nightly.computer-use"');
    assert.include(preview, 'ParentExecutable = "GOAT.exe";');
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
        renderWindowsBuildInfo({
          channel: "dev",
          version: "1.0.0",
          pins: [pin],
          allowAnyParent: true,
        }),
      );
  });
});
