import { assert, describe, it } from "@effect/vitest";

import { pidsSafeToClose } from "./windows-shared-hosts.ts";

describe("windows-shared-hosts", () => {
  it("never closes a shared window host, even when a harness's window reports it as owner (#1247)", () => {
    assert.deepEqual(
      pidsSafeToClose(
        [
          { pid: 10, image: "computer-use-windows-fixture.exe" },
          { pid: 11, image: "Notepad.exe" },
          // Calculator's window belongs to the frame host every packaged app shares.
          { pid: 12, image: "ApplicationFrameHost.exe" },
          { pid: 13, image: "EXPLORER.EXE" },
        ],
        new Set(),
      ),
      [10, 11],
    );
  });

  it("never closes a process that was running before the run started", () => {
    assert.deepEqual(pidsSafeToClose([{ pid: 11, image: "Notepad.exe" }], new Set([11])), []);
  });
});
