// @effect-diagnostics nodeBuiltinImport:off - verifies real recording files and staged cleanup.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import type { Page } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { saveRecording } from "./ServerBrowserRecordingExport.ts";

it.each([false, true])(
  "saves a large recording and removes the staged file (truncated: %s)",
  async (truncated) => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "goat-recording-export-"),
    );
    const payload = Buffer.alloc(8 * 1024 * 1024, 0x5a);
    const download = Promise.withResolvers<{ saveAs: (path: string) => Promise<void> }>();
    let stagedPath = "";
    const sandbox = NodeVM.createContext({
      __goatRecorder: {
        chunk: async () => {
          throw new Error("Large recording used Base64 export");
        },
        download: () =>
          download.resolve({
            saveAs: async (path) => {
              stagedPath = path;
              await NodeFSP.writeFile(path, truncated ? payload.subarray(1) : payload);
            },
          }),
      },
    });
    const encoder = {
      evaluate: (fn: (input: unknown) => unknown, arg?: unknown) =>
        NodeVM.runInContext(`(${fn.toString()})`, sandbox)(arg),
      waitForEvent: () => download.promise,
    } as unknown as Page;
    try {
      const result = saveRecording(
        encoder,
        { mimeType: "video/webm", count: 1, bytes: payload.length },
        directory,
        "tab",
      );
      if (truncated) await expect(result).rejects.toThrow("incomplete");
      else {
        const artifact = await result;
        expect(artifact.sizeBytes).toBe(payload.length);
        expect((await NodeFSP.readFile(artifact.path)).equals(payload)).toBe(true);
      }
      expect(stagedPath).not.toBe("");
      await expect(NodeFSP.stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);
