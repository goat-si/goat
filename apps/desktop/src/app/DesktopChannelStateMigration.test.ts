// @effect-diagnostics nodeBuiltinImport:off - exercises the pre-ready migration against real temporary directories.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { assert, describe, it } from "@effect/vitest";

import { AUTOMATION_HOLD_FILE_NAME, decodeAutomationHold } from "@goat/contracts";

import {
  CHANNEL_STATE_MIGRATION_MARKER,
  ChannelStateMigrationError,
  copyFileWithin,
  migrateChannelState,
  resolveChannelStateMigration,
  type ChannelStateMigrationOps,
} from "./DesktopChannelStateMigration.ts";

const copiedAt = "2026-10-25T00:00:00.000Z";

const read = (path: string) => NodeFS.readFileSync(path, "utf8");

const listTree = (root: string): string[] =>
  NodeFS.readdirSync(root, { recursive: true, encoding: "utf8" })
    .map((entry) => entry.split(NodePath.sep).join("/"))
    .toSorted();

const withHome = (run: (home: string) => void) => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-channel-state-"));
  try {
    run(home);
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
};

const write = (path: string, contents: string) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, contents);
};

/** A stable home whose server is still running: the newest rows exist only in the WAL. */
const seedStable = (home: string) => {
  const source = NodePath.join(home, ".goat", "desktop");
  const userdata = NodePath.join(source, "userdata");
  write(NodePath.join(userdata, "settings.json"), '{"theme":"dark"}');
  write(NodePath.join(userdata, "environment-id"), "env-stable");
  write(NodePath.join(userdata, "connection-catalog.json"), "ciphertext");
  write(NodePath.join(userdata, "secrets", "handoff-encryption-key.bin"), "key");
  write(NodePath.join(userdata, "secrets", "server-signing-key.bin.1234.tmp"), "partial");
  write(NodePath.join(userdata, "attachments", "thread-1", "image.png"), "png");
  write(NodePath.join(userdata, "logs", "server.trace.ndjson"), "trace");
  write(NodePath.join(userdata, "server-runtime.json"), '{"pid":1}');
  write(NodePath.join(source, "notes", "todo.md"), "# notes");
  write(NodePath.join(source, "caches", "provider-status.json"), "{}");
  write(NodePath.join(source, "worktrees", "repo", "README.md"), "worktree");
  const db = new NodeSqlite.DatabaseSync(NodePath.join(userdata, "statev2.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE threads(id TEXT); INSERT INTO threads VALUES ('t1'), ('t2');",
  );
  return {
    source,
    destination: NodePath.join(home, ".goat", "desktop-nightly"),
    db,
  };
};

const migrate = (
  stable: { readonly source: string; readonly destination: string },
  ops?: Partial<ChannelStateMigrationOps>,
) =>
  migrateChannelState({
    sourceBaseDir: stable.source,
    destinationBaseDir: stable.destination,
    appVersion: "1.2.3-nightly.20261025.1",
    // The POSIX flush path; CI runs these on Linux and macOS.
    platform: "linux",
    copiedAt,
    ...(ops === undefined ? {} : { ops }),
  });

const stagingEntries = (home: string) =>
  NodeFS.readdirSync(NodePath.join(home, ".goat")).filter((name) => name.includes(".migrating-"));

describe("resolveChannelStateMigration", () => {
  const base = { homeDirectory: "/home/alice", isDevelopment: false, goatHome: undefined };

  it("migrates only a packaged nightly or preview build on the default home", () => {
    assert.deepEqual(
      resolveChannelStateMigration({
        ...base,
        isPackaged: true,
        appVersion: "1.2.3-nightly.20261025.1",
      }),
      {
        sourceBaseDir: "/home/alice/.goat/desktop",
        destinationBaseDir: "/home/alice/.goat/desktop-nightly",
      },
    );
    assert.notEqual(
      resolveChannelStateMigration({
        ...base,
        isPackaged: true,
        appVersion: "1.2.3-preview.20261025.1",
      }),
      null,
    );
    assert.equal(
      resolveChannelStateMigration({ ...base, isPackaged: true, appVersion: "1.2.3" }),
      null,
    );
    assert.equal(
      resolveChannelStateMigration({
        ...base,
        isPackaged: true,
        isDevelopment: true,
        appVersion: "1.2.3-nightly.20261025.1",
      }),
      null,
    );
    assert.equal(
      resolveChannelStateMigration({
        ...base,
        isPackaged: false,
        appVersion: "1.2.3-nightly.20261025.1",
      }),
      null,
    );
    assert.equal(
      resolveChannelStateMigration({
        ...base,
        isPackaged: true,
        goatHome: "/isolated",
        appVersion: "1.2.3-nightly.20261025.1",
      }),
      null,
    );
  });
});

describe("migrateChannelState", () => {
  it("copies a consistent snapshot and the listed state, holds automation, and leaves stable untouched", () =>
    withHome((home) => {
      const stable = seedStable(home);
      try {
        const before = listTree(stable.source);
        const result = migrate(stable);

        assert.equal(result._tag, "Copied");
        const userdata = NodePath.join(stable.destination, "userdata");
        const copy = new NodeSqlite.DatabaseSync(NodePath.join(userdata, "statev2.sqlite"), {
          readOnly: true,
        });
        assert.deepEqual(
          copy
            .prepare("SELECT id FROM threads ORDER BY id")
            .all()
            .map((row) => row.id),
          ["t1", "t2"],
        );
        copy.close();
        assert.equal(read(NodePath.join(userdata, "environment-id")), "env-stable");
        assert.equal(read(NodePath.join(userdata, "secrets", "handoff-encryption-key.bin")), "key");
        assert.equal(read(NodePath.join(userdata, "attachments", "thread-1", "image.png")), "png");
        assert.equal(read(NodePath.join(stable.destination, "notes", "todo.md")), "# notes");
        assert.deepEqual(
          decodeAutomationHold(read(NodePath.join(userdata, AUTOMATION_HOLD_FILE_NAME))),
          { reason: "channel-copy", heldAt: "2026-10-25T00:00:00.000Z" },
        );
        const copied = listTree(stable.destination);
        for (const skipped of [
          "userdata/logs",
          "userdata/server-runtime.json",
          "userdata/secrets/server-signing-key.bin.1234.tmp",
          "caches",
          "worktrees",
        ]) {
          assert.notInclude(copied, skipped);
        }
        assert.include(copied, CHANNEL_STATE_MIGRATION_MARKER);

        // Stable keeps every file and its server keeps writing to its own database.
        assert.deepEqual(
          listTree(stable.source).filter(
            (entry) => !entry.endsWith("-shm") && !entry.endsWith("-wal"),
          ),
          before.filter((entry) => !entry.endsWith("-shm") && !entry.endsWith("-wal")),
        );
        assert.notInclude(listTree(stable.source), `userdata/${AUTOMATION_HOLD_FILE_NAME}`);
        stable.db.exec("INSERT INTO threads VALUES ('t3')");
        assert.equal(stable.db.prepare("SELECT count(*) AS n FROM threads").get()?.n, 3);
        assert.deepEqual(stagingEntries(home), []);
        assert.equal(migrate(stable)._tag, "DestinationExists");
      } finally {
        stable.db.close();
      }
    }));

  it("copies read-only files such as the notes repository's Git objects", () =>
    withHome((home) => {
      const stable = seedStable(home);
      try {
        const object = NodePath.join(stable.source, "notes", ".git", "objects", "ab", "cdef");
        write(object, "blob");
        NodeFS.chmodSync(object, 0o444);

        assert.equal(migrate(stable)._tag, "Copied");

        const copied = NodePath.join(stable.destination, "notes", ".git", "objects", "ab", "cdef");
        assert.equal(read(copied), "blob");
        assert.equal(NodeFS.statSync(copied).mode & 0o777, 0o444);
      } finally {
        stable.db.close();
      }
    }));

  it("never follows a link out of the stable home", () =>
    withHome((home) => {
      const stable = seedStable(home);
      try {
        const outside = NodePath.join(home, "outside");
        write(NodePath.join(outside, "private.txt"), "not GOAT's");
        const userdata = NodePath.join(stable.source, "userdata");
        NodeFS.rmSync(NodePath.join(userdata, "settings.json"));
        NodeFS.symlinkSync(
          NodePath.join(outside, "private.txt"),
          NodePath.join(userdata, "settings.json"),
        );
        NodeFS.symlinkSync(outside, NodePath.join(userdata, "themes"));
        NodeFS.symlinkSync(outside, NodePath.join(userdata, "attachments", "linked"));

        assert.equal(migrate(stable)._tag, "Copied");

        const copied = listTree(stable.destination);
        assert.notInclude(copied, "userdata/settings.json");
        assert.notInclude(copied, "userdata/themes");
        assert.notInclude(copied, "userdata/attachments/linked");
        assert.include(copied, "userdata/attachments/thread-1/image.png");
      } finally {
        stable.db.close();
      }
    }));

  it("copies nothing when stable's userdata is a link out of its home", () =>
    withHome((home) => {
      const outside = NodePath.join(home, "elsewhere", "userdata");
      write(NodePath.join(outside, "settings.json"), "not GOAT's");
      const source = NodePath.join(home, ".goat", "desktop");
      NodeFS.mkdirSync(source, { recursive: true });
      NodeFS.symlinkSync(outside, NodePath.join(source, "userdata"));
      const destination = NodePath.join(home, ".goat", "desktop-nightly");

      assert.equal(migrate({ source, destination })._tag, "SourceUnsafe");
      assert.isFalse(NodeFS.existsSync(destination));
    }));

  it("copies a stable home that lives behind a link, such as on another disk", () =>
    withHome((home) => {
      const stable = seedStable(home);
      try {
        const linked = NodePath.join(home, "linked-desktop");
        NodeFS.symlinkSync(stable.source, linked);
        const result = migrate({ source: linked, destination: stable.destination });
        assert.equal(result._tag, "Copied");
        assert.equal(
          read(NodePath.join(stable.destination, "userdata", "environment-id")),
          "env-stable",
        );
      } finally {
        stable.db.close();
      }
    }));

  it("refuses a file swapped for a link after it was listed, and publishes nothing", () =>
    withHome((home) => {
      const stable = seedStable(home);
      try {
        const secret = NodePath.join(home, "outside-secret.txt");
        write(secret, "not GOAT's");
        let failure: unknown;
        try {
          migrate(stable, {
            copyFile: (source, destination, sourceRoot) => {
              if (source.endsWith("environment-id")) {
                NodeFS.rmSync(source);
                NodeFS.symlinkSync(secret, source);
              }
              copyFileWithin(source, destination, sourceRoot);
            },
          });
        } catch (cause) {
          failure = cause;
        }
        assert.instanceOf(failure, ChannelStateMigrationError);
        assert.isFalse(NodeFS.existsSync(stable.destination));
        assert.deepEqual(stagingEntries(home), []);
      } finally {
        stable.db.close();
      }
    }));

  it("starts a fresh nightly when stable never ran, and never copies later", () =>
    withHome((home) => {
      const destination = NodePath.join(home, ".goat", "desktop-nightly");
      const stable = { source: NodePath.join(home, ".goat", "desktop"), destination };
      assert.equal(migrate(stable)._tag, "NoSource");
      assert.isFalse(NodeFS.existsSync(destination));
    }));

  it("never overwrites a destination that already holds data", () =>
    withHome((home) => {
      const stable = seedStable(home);
      try {
        write(NodePath.join(stable.destination, "userdata", "settings.json"), '{"mine":true}');
        assert.equal(migrate(stable)._tag, "DestinationExists");
        assert.equal(
          read(NodePath.join(stable.destination, "userdata", "settings.json")),
          '{"mine":true}',
        );
        assert.isFalse(
          NodeFS.existsSync(NodePath.join(stable.destination, CHANNEL_STATE_MIGRATION_MARKER)),
        );
      } finally {
        stable.db.close();
      }
    }));

  it.each(["ENOSPC", "EACCES"])(
    "publishes nothing after a %s copy failure and copies on the next launch",
    (code) =>
      withHome((home) => {
        const stable = seedStable(home);
        try {
          const failing: Partial<ChannelStateMigrationOps> = {
            copyFile: (source, destination) => {
              if (source.includes("attachments")) {
                throw Object.assign(new Error(`${code}: simulated`), { code });
              }
              NodeFS.copyFileSync(source, destination);
            },
          };
          assert.throws(() => migrate(stable, failing), ChannelStateMigrationError);
          assert.isFalse(NodeFS.existsSync(stable.destination));
          assert.deepEqual(stagingEntries(home), []);

          assert.equal(migrate(stable)._tag, "Copied");
        } finally {
          stable.db.close();
        }
      }),
  );

  it("publishes nothing when the database snapshot fails verification", () =>
    withHome((home) => {
      const stable = seedStable(home);
      try {
        let failure: unknown;
        try {
          migrate(stable, {
            verifyDatabase: () => {
              throw new Error("quick_check reported: corrupt");
            },
          });
        } catch (cause) {
          failure = cause;
        }
        assert.instanceOf(failure, ChannelStateMigrationError);
        assert.equal((failure as ChannelStateMigrationError).step, "snapshot");
        assert.isFalse(NodeFS.existsSync(stable.destination));
        assert.deepEqual(stagingEntries(home), []);
      } finally {
        stable.db.close();
      }
    }));

  it("discards a copy a crashed launch left behind, but not one a live launch is writing", () =>
    withHome((home) => {
      const stable = seedStable(home);
      try {
        const crashed = NodePath.join(home, ".goat", "desktop-nightly.migrating-424242-aaaa");
        const live = NodePath.join(home, ".goat", "desktop-nightly.migrating-525252-bbbb");
        write(NodePath.join(crashed, "userdata", "statev2.sqlite"), "half");
        write(NodePath.join(live, "userdata", "statev2.sqlite"), "in progress");

        const result = migrate(stable, { isProcessAlive: (pid) => pid === 525252 });

        assert.equal(result._tag, "Copied");
        assert.deepEqual(stagingEntries(home), ["desktop-nightly.migrating-525252-bbbb"]);
      } finally {
        stable.db.close();
      }
    }));

  it("uses the copy a racing first launch published first", () =>
    withHome((home) => {
      const stable = seedStable(home);
      try {
        let raced = false;
        let lostRename: unknown;
        const result = migrate(stable, {
          rename: (from, to) => {
            if (!raced) {
              raced = true;
              assert.equal(migrate(stable)._tag, "Copied");
              try {
                NodeFS.renameSync(from, to);
              } catch (cause) {
                lostRename = cause;
                throw cause;
              }
              return;
            }
            NodeFS.renameSync(from, to);
          },
        });

        assert.equal(result._tag, "CopiedByAnotherLaunch");
        assert.isDefined(lostRename);
        assert.isTrue(
          NodeFS.existsSync(NodePath.join(stable.destination, CHANNEL_STATE_MIGRATION_MARKER)),
        );
        assert.deepEqual(stagingEntries(home), []);
      } finally {
        stable.db.close();
      }
    }));
});
