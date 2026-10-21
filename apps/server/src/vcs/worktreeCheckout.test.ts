import { assert, describe, it } from "@effect/vitest";

import {
  defaultCheckoutWorkers,
  missingWindowsCheckoutSettings,
  worktreeSparseCheckoutPatterns,
} from "./worktreeCheckout.ts";

describe("worktreeSparseCheckoutPatterns", () => {
  it("keeps everything but the excluded directories", () => {
    assert.equal(worktreeSparseCheckoutPatterns([".repos/"]), "/*\n!/.repos/\n");
    assert.equal(
      worktreeSparseCheckoutPatterns(["./.repos", "/vendor/big/", ".repos", "  "]),
      "/*\n!/.repos/\n!/vendor/big/\n",
    );
  });

  it("accepts Windows separators from a hand-written project file", () => {
    assert.equal(
      worktreeSparseCheckoutPatterns([".\\.repos\\effect-smol\\"]),
      "/*\n!/.repos/effect-smol/\n",
    );
  });

  it("ignores entries that would exclude something other than one directory", () => {
    for (const entry of ["", "/", "../outside", "a/../b", "*.md", "!keep", "a//b", "#x"]) {
      assert.isNull(worktreeSparseCheckoutPatterns([entry]), entry);
    }
    assert.isNull(worktreeSparseCheckoutPatterns([]));
  });
});

describe("Windows checkout settings", () => {
  it("only fills settings no config level has", () => {
    const configured: Record<string, string> = { "core.fscache": "false" };
    assert.deepStrictEqual(
      missingWindowsCheckoutSettings((key) => configured[key] ?? null).map(({ key }) => key),
      ["core.longpaths"],
    );
  });

  it("caps parallel checkout on Windows, where one worker per core can crash Git", () => {
    assert.equal(defaultCheckoutWorkers("win32"), "8");
    assert.equal(defaultCheckoutWorkers("linux"), "0");
    assert.equal(defaultCheckoutWorkers("darwin"), "0");
  });
});
