import { describe, expect, it } from "@effect/vitest";

import { databasesByPid, looksLikeGoatServer } from "./localGoatServers.ts";

describe("local GOAT server discovery", () => {
  it("recognises the server entry points the desktop app, dev runner and service start", () => {
    expect(
      looksLikeGoatServer(
        "/Users/me/.goat/runtime/goat/versions/0.1.2/goat serve --host 127.0.0.1 --port 3774 --base-dir /Users/me/.goat",
      ),
    ).toBe(true);
    expect(
      looksLikeGoatServer(
        "/Applications/GOAT.app/Contents/MacOS/GOAT /Applications/GOAT.app/Contents/Resources/app/apps/server/dist/bin.mjs --bootstrap-fd 3",
      ),
    ).toBe(true);
    expect(looksLikeGoatServer("node /work/goat/apps/server/src/bin.ts serve --port 1")).toBe(true);
    // Every way the CLI runs a server: no subcommand, only flags, or start.
    for (const command of [
      "/usr/local/bin/goat start --base-dir /srv/goat-home",
      "/usr/local/bin/goat --base-dir /srv/goat-home",
      "goat",
      "C:\\Tools\\goat.exe start",
      "node /usr/local/lib/node_modules/goat/dist/bin.mjs --port 3774",
    ])
      expect(looksLikeGoatServer(command), command).toBe(true);
    for (const command of [
      "/usr/local/bin/goat thread start --title x",
      "/usr/local/bin/goat storage --dry-run",
      "/Applications/GOAT.app/Contents/MacOS/GOAT",
    ])
      expect(looksLikeGoatServer(command), command).toBe(false);
    // Helpers, test runners and editors that only mention a GOAT path are not servers.
    expect(
      looksLikeGoatServer(
        "/Applications/GOAT.app/Contents/Frameworks/GOAT Helper (Renderer).app --type=renderer",
      ),
    ).toBe(false);
    expect(looksLikeGoatServer("node /work/goat/node_modules/.bin/vitest run")).toBe(false);
    expect(
      looksLikeGoatServer(
        "/Applications/GOAT.app/Contents/MacOS/GOAT /Applications/GOAT.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs cua-lease-proxy --control c",
      ),
    ).toBe(false);
  });

  it("reads which database each process holds open from lsof field output", () => {
    const output = [
      "p101",
      "n/Users/me/.goat/desktop/userdata/statev2.sqlite",
      "n/Users/me/.goat/desktop/userdata/statev2.sqlite-wal",
      "p202",
      "n/dev/null",
      "p303",
      "n/Users/me/.goat/userdata/statev2.sqlite",
    ].join("\n");
    expect([...databasesByPid(output)]).toEqual([
      [101, ["/Users/me/.goat/desktop/userdata/statev2.sqlite"]],
      [303, ["/Users/me/.goat/userdata/statev2.sqlite"]],
    ]);
  });
});
