import { assert, describe, it } from "@effect/vitest";

import {
  defaultCheckoutWorkers,
  missingWindowsCheckoutSettings,
  worktreeFolderName,
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

describe("worktreeFolderName", () => {
  it("keeps POSIX folder names as before", () => {
    assert.equal(worktreeFolderName('feature/a"b<c>|d.', "linux"), 'feature-a"b<c>|d.');
    assert.equal(worktreeFolderName("con", "darwin"), "con");
  });

  it("avoids names Windows refuses", () => {
    assert.equal(worktreeFolderName('feature/a"b<c>|d', "win32"), "feature-a-b-c--d");
    assert.equal(worktreeFolderName("release/1.0. ", "win32"), "release-1.0");
    assert.equal(worktreeFolderName("CON", "win32"), "CON-branch");
    assert.equal(worktreeFolderName("lpt1.txt", "win32"), "lpt1.txt-branch");
    assert.equal(worktreeFolderName("console", "win32"), "console");
  });
});
