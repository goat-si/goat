// Lifted from GOAT v1 packages/shared/src/shell.test.ts (origin/dev 916b5ccc1b2): the
// listLoginShellCandidates and mergePathValues cases, vite-plus expect rewritten as node:assert.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listLoginShellCandidates, mergePathValues } from "./shellPath.ts";

describe("listLoginShellCandidates", () => {
  it("returns env shell, user shell, then the platform fallback without duplicates", () => {
    assert.deepEqual(listLoginShellCandidates("darwin", " /opt/homebrew/bin/nu ", "/bin/zsh"), [
      "/opt/homebrew/bin/nu",
      "/bin/zsh",
    ]);
  });
});

describe("mergePathValues", () => {
  it("sanitizes and dedupes Windows entries while preserving preferred order", () => {
    assert.equal(
      mergePathValues(
        'C:\\Users\\testuser\\AppData\\Roaming\\npm;"C:\\Program Files\\nodejs"',
        "c:\\users\\testuser\\appdata\\roaming\\npm;C:\\Windows\\System32",
        "win32",
      ),
      "C:\\Users\\testuser\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs;C:\\Windows\\System32",
    );
  });

  it("removes stray quotes from Windows entries", () => {
    assert.equal(
      mergePathValues('C:\\Windows\\System32;C:\\cloudflared.exe;C:";C:\\Program Files\\nodejs', undefined, "win32"),
      "C:\\Windows\\System32;C:\\cloudflared.exe;C:;C:\\Program Files\\nodejs",
    );
  });

  it("dedupes case-sensitively on POSIX", () => {
    assert.equal(mergePathValues("/usr/local/bin:/usr/bin", "/usr/bin:/USR/BIN", "linux"), "/usr/local/bin:/usr/bin:/USR/BIN");
  });
});
