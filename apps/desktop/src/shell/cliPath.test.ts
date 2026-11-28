// Lifted from GOAT v1 packages/shared/src/cliPath.test.ts (origin/dev 916b5ccc1b2): the pure cases,
// vite-plus expect rewritten as node:assert, values unchanged. Left out: resolveCommandPath and the
// login-shell note (not lifted).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendWellKnownCliDirs, wellKnownCliDirs } from "./cliPath.ts";

describe("well-known CLI folders", () => {
  // An empty PATH component means the working directory; dropping one would change what runs.
  for (const [label, original] of [
    ["a trailing delimiter", "/usr/bin:"],
    ["a leading delimiter", ":/usr/bin"],
    ["an empty component in the middle", "/usr/bin::/bin"],
    ["only empty components", ":"],
    ["spaces around an entry", " /usr/bin :/bin"],
  ] as const) {
    it(`appends to the PATH exactly as it is, with ${label}`, () => {
      const appended = appendWellKnownCliDirs(original, "darwin", "/Users/me");
      assert.equal(appended, original + ":/Users/me/.local/bin:/Users/me/.bun/bin:/opt/homebrew/bin:/usr/local/bin");
      assert.equal(appended.startsWith(original + ":"), true);
    });
  }

  it("keeps the PATH byte for byte when a folder is already on it, empty components included", () => {
    const original = ":/opt/homebrew/bin::/Users/me/.local/bin:";
    assert.equal(appendWellKnownCliDirs(original, "darwin", "/Users/me"), original + ":/Users/me/.bun/bin:/usr/local/bin");
    const complete = "/Users/me/.local/bin:/Users/me/.bun/bin:/opt/homebrew/bin:/usr/local/bin:";
    assert.equal(appendWellKnownCliDirs(complete, "darwin", "/Users/me"), complete);
  });

  it("adds the folders last without reordering or repeating what PATH already has", () => {
    assert.equal(
      appendWellKnownCliDirs("/shell/bin:/Users/me/.local/bin/:/usr/bin", "darwin", "/Users/me/"),
      "/shell/bin:/Users/me/.local/bin/:/usr/bin:/Users/me/.bun/bin:/opt/homebrew/bin:/usr/local/bin",
    );
    assert.equal(
      appendWellKnownCliDirs("/usr/bin", "linux", "/home/me"),
      "/usr/bin:/home/me/.local/bin:/home/me/.bun/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin",
    );
  });

  it("names absolute folders only and leaves Windows and a missing PATH alone", () => {
    assert.equal(appendWellKnownCliDirs(undefined, "darwin", "/Users/me"), undefined);
    // A home holding the PATH delimiter would split into a relative entry such as ./.local/bin.
    for (const home of [undefined, "", "relative/home", "~", "/", "//", "/Users/alice:."]) {
      assert.deepEqual(wellKnownCliDirs("linux", home), ["/home/linuxbrew/.linuxbrew/bin", "/usr/local/bin"]);
    }
    assert.equal(appendWellKnownCliDirs("/usr/bin", "darwin", "/Users/alice:."), "/usr/bin:/opt/homebrew/bin:/usr/local/bin");
    assert.deepEqual(wellKnownCliDirs("win32", "C:\\Users\\me"), []);
    assert.equal(appendWellKnownCliDirs("C:\\Windows", "win32", "C:\\Users\\me"), "C:\\Windows");
    assert.equal(appendWellKnownCliDirs(null, "darwin", "/Users/me"), null);
    assert.equal(appendWellKnownCliDirs("", "darwin", "/Users/me"), "");
  });

  it("keeps a home folder whose name ends in a space, and only strips trailing slashes", () => {
    assert.deepEqual(wellKnownCliDirs("darwin", "/Users/al //"), [
      "/Users/al /.local/bin",
      "/Users/al /.bun/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]);
    assert.equal(
      appendWellKnownCliDirs("/usr/bin:/Users/al/.local/bin", "darwin", "/Users/al "),
      "/usr/bin:/Users/al/.local/bin:/Users/al /.local/bin:/Users/al /.bun/bin:/opt/homebrew/bin:/usr/local/bin",
    );
  });
});
