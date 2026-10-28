// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as AttachmentFileLeases from "./AttachmentFileLeases.ts";
import { makeSweepCursor, nodeSweepFileSystem } from "./PendingAttachmentSweepCursor.ts";

const now = 1_800_000_000_000;
const id = "pending-00000000-0000-4000-8000-000000000002";
const old = {
  dev: 1,
  ino: 2,
  mtimeMs: now - 172_800_000,
  size: 6,
  isFile: () => true,
  isSymbolicLink: () => false,
};
const inactive: Parameters<typeof makeSweepCursor>[0]["withInactiveFile"] = (_file, remove) =>
  remove;

it.effect("advances through 2000 entries with one handle and at most 512 entries per step", () =>
  Effect.gen(function* () {
    let index = 0;
    let opens = 0;
    let closes = 0;
    const removed: string[] = [];
    const cursor = makeSweepCursor({
      attachmentsDir: "/attachments",
      withInactiveFile: inactive,
      fileSystem: {
        open: async () => {
          opens++;
          return {
            read: async () => (index < 2000 ? { name: `${id}-${index++}.part` } : null),
            close: async () => {
              closes++;
            },
          };
        },
        lstat: async () => old,
        unlink: async (file) => {
          removed.push(file);
        },
      },
    });
    const reports = [];
    for (let step = 0; step < 4; step++) reports.push(yield* cursor.step(now));
    yield* cursor.close;
    expect(reports.map((report) => report.visited)).toEqual([512, 512, 512, 464]);
    expect(reports.map((report) => report.complete)).toEqual([false, false, false, true]);
    expect(new Set(removed).size).toBe(2000);
    expect({ opens, closes }).toEqual({ opens: 1, closes: 1 });
  }),
);

it.effect.each([
  "stat",
  "identity",
  "permission",
  "lease",
  "symlink",
  "directory",
  "future",
  "boundary",
] as const)("keeps a candidate on %s uncertainty or ineligibility", (failure) =>
  Effect.gen(function* () {
    let reads = 0;
    let stats = 0;
    let removed = 0;
    let closes = 0;
    const cursor = makeSweepCursor({
      attachmentsDir: "/attachments",
      withInactiveFile: failure === "lease" ? () => Effect.die("unknown lease") : inactive,
      fileSystem: {
        open: async () => ({
          read: async () => (reads++ === 0 ? { name: `${id}.png` } : null),
          close: async () => {
            closes++;
          },
        }),
        lstat: async () => {
          stats++;
          if (failure === "stat") throw new Error("stat denied");
          return {
            ...old,
            ino: failure === "identity" && stats === 2 ? 3 : old.ino,
            mtimeMs:
              failure === "future"
                ? now + 1
                : failure === "boundary"
                  ? now - 86_400_000
                  : old.mtimeMs,
            isFile: () => failure !== "directory",
            isSymbolicLink: () => failure === "symlink",
          };
        },
        unlink: async () => {
          if (failure === "permission") throw new Error("denied");
          removed++;
        },
      },
    });
    const report = yield* cursor.step(now);
    yield* cursor.close;
    expect(removed).toBe(0);
    expect(closes).toBe(1);
    expect(report.complete).toBe(true);
    expect(report.keptUnknown).toBe(
      ["stat", "identity", "permission", "lease"].includes(failure) ? 1 : 0,
    );
  }),
);

it.effect(
  "does not reopen after an uncertain close and reports a directory read failure as incomplete",
  () =>
    Effect.gen(function* () {
      let opens = 0;
      let closes = 0;
      let allowClose = false;
      const cursor = makeSweepCursor({
        attachmentsDir: "/attachments",
        withInactiveFile: inactive,
        fileSystem: {
          ...nodeSweepFileSystem,
          open: async () => {
            opens++;
            return {
              read: async () => {
                throw new Error("read denied");
              },
              close: async () => {
                closes++;
                if (!allowClose) throw new Error("unknown close");
              },
            };
          },
        },
      });
      expect(yield* cursor.step(now)).toMatchObject({ complete: false, keptUnknown: 2 });
      expect(yield* cursor.step(now)).toMatchObject({ complete: false, keptUnknown: 1 });
      expect(opens).toBe(1);
      allowClose = true;
      yield* cursor.close;
      expect(closes).toBe(3);
    }),
);

it.effect(
  "retains unknown partials and thread files while deleting recognized old uploads and sidecars",
  () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const leases = yield* AttachmentFileLeases.AttachmentFileLeases;
      const names = [
        `${id}.png`,
        `${id}-pdf.pdf`,
        `${id}-pdf.pdf.txt`,
        `${id}.png.00000000-0000-4000-8000-000000000003.part`,
        `${id}-ipynb.ipynb.txt.part`,
        "00000000-0000-4000-8000-000000000004.part",
        "thread-00000000-0000-4000-8000-000000000002.png",
        "thread-00000000-0000-4000-8000-000000000002.ipynb.txt.part",
      ];
      for (const name of names) {
        const file = NodePath.join(config.attachmentsDir, name);
        NodeFS.writeFileSync(file, "pixels");
        NodeFS.utimesSync(file, old.mtimeMs / 1000, old.mtimeMs / 1000);
      }
      const link = NodePath.join(config.attachmentsDir, `${id}-bin.bin`);
      NodeFS.symlinkSync(NodePath.join(config.attachmentsDir, names[0]!), link);
      const cursor = makeSweepCursor({
        attachmentsDir: config.attachmentsDir,
        withInactiveFile: leases.withInactiveFile,
      });
      const report = yield* cursor.step(now);
      yield* cursor.close;
      expect(report).toMatchObject({ deleted: 5, complete: true });
      for (const name of names.slice(0, 5))
        expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, name))).toBe(false);
      for (const name of names.slice(5))
        expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, name))).toBe(true);
      expect(NodeFS.lstatSync(link).isSymbolicLink()).toBe(true);
    }).pipe(
      Effect.provide(
        AttachmentFileLeases.layer.pipe(
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "goat-sweep-cursor-" }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.effect.each([
  { name: `${id}.png`, age: 86_400_000 },
  { name: `${id}-pdf.pdf.txt`, age: 86_400_000 },
  { name: `${id}.png.00000000-0000-4000-8000-000000000003.part`, age: 3_600_000 },
] as const)(
  "keeps $name at its exact expiry boundary and deletes it only after the boundary",
  ({ name, age }) =>
    Effect.gen(function* () {
      let read = false;
      let deleted = 0;
      const cursor = makeSweepCursor({
        attachmentsDir: "/attachments",
        withInactiveFile: inactive,
        fileSystem: {
          open: async () => {
            read = false;
            return {
              read: async () => {
                if (read) return null;
                read = true;
                return { name };
              },
              close: async () => {},
            };
          },
          lstat: async () => ({ ...old, mtimeMs: now - age }),
          unlink: async () => {
            deleted++;
          },
        },
      });
      expect(yield* cursor.step(now)).toMatchObject({ deleted: 0, complete: true });
      expect(yield* cursor.step(now + 1)).toMatchObject({ deleted: 1, complete: true });
      yield* cursor.close;
      expect(deleted).toBe(1);
    }),
);

it.effect(
  "keeps escaped paths and retries directory failure with a fresh handle on the next pass",
  () =>
    Effect.gen(function* () {
      let opens = 0;
      let reads = 0;
      let closes = 0;
      let stats = 0;
      const cursor = makeSweepCursor({
        attachmentsDir: "/attachments",
        withInactiveFile: inactive,
        fileSystem: {
          open: async () => {
            const pass = ++opens;
            return {
              read: async () => {
                if (pass === 1) throw new Error("unreadable directory");
                return reads++ === 0
                  ? { name: `../${id}.png.00000000-0000-4000-8000-000000000003.part` }
                  : null;
              },
              close: async () => {
                closes++;
              },
            };
          },
          lstat: async () => {
            stats++;
            return old;
          },
          unlink: async () => {
            throw new Error("must not delete");
          },
        },
      });
      expect(yield* cursor.step(now)).toMatchObject({ complete: false, keptUnknown: 1 });
      expect(yield* cursor.step(now)).toMatchObject({ complete: true, keptUnknown: 1, deleted: 0 });
      yield* cursor.close;
      expect({ opens, closes, stats }).toEqual({ opens: 2, closes: 2, stats: 0 });
    }),
);
