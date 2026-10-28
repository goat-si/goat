// @effect-diagnostics nodeBuiltinImport:off - artifacts are plain files written outside the Effect runtime.
import * as HostProcess from "@goat/shared/HostProcess";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Page } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { publishArtifact, publishFetchedBody } from "./browserArtifacts.ts";
import { inPageFetch } from "./inPageFetch.ts";
import { SessionControl } from "./SessionControl.ts";

const posix = HostProcess.Platform.defaultValue() !== "win32";

const withDir = async (run: (dir: string) => Promise<void>) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-artifacts-"));
  try {
    await run(NodePath.join(root, "browser-artifacts"));
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
};

const fetched = (body: Uint8Array) => ({
  url: "https://app.example/files/logo.png?token=redacted",
  status: 200,
  ok: true,
  contentType: "image/png",
  format: "raw" as const,
  text: "",
  truncated: false,
  body,
});

it("saves a fetched body as an owner-only file and returns its path instead of the bytes", () =>
  withDir(async (dir) => {
    await NodeFSP.mkdir(dir, { mode: 0o755 });
    if (posix) await NodeFSP.chmod(dir, 0o755);
    const result = await publishFetchedBody(dir, fetched(Uint8Array.of(1, 2, 3)), Infinity);
    expect(result).not.toHaveProperty("body");
    expect(result).toMatchObject({ sizeBytes: 3, format: "raw" });
    const { savedPath } = result as unknown as { readonly savedPath: string };
    expect(NodePath.dirname(savedPath)).toBe(dir);
    expect(NodePath.basename(savedPath)).toMatch(
      /^browser-fetch-app-example-[0-9a-z]+-[0-9a-f]{8}\.png$/,
    );
    expect([...(await NodeFSP.readFile(savedPath))]).toEqual([1, 2, 3]);
    if (posix) {
      expect((await NodeFSP.stat(savedPath)).mode & 0o777).toBe(0o600);
      expect((await NodeFSP.stat(dir)).mode & 0o777).toBe(0o700);
    }
  }));

it("writes nothing once the caller's deadline has passed", () =>
  withDir(async (dir) => {
    const result = await publishFetchedBody(dir, fetched(Uint8Array.of(1)), 0);
    expect(result).not.toHaveProperty("body");
    expect(result).not.toHaveProperty("savedPath");
    expect(NodeFS.existsSync(dir) ? await NodeFSP.readdir(dir) : []).toEqual([]);
  }));

it("leaves no partial file when saving fails midway", () =>
  withDir(async (dir) => {
    await expect(
      publishArtifact(dir, "browser-fetch-x.bin", async (path) => {
        await NodeFSP.writeFile(path, "half");
        throw new Error("disk full");
      }),
    ).rejects.toThrow("disk full");
    expect(await NodeFSP.readdir(dir)).toEqual([]);
  }));

it("writes nothing when an outer observation is withheld after the fetch finished", () =>
  withDir(async (dir) => {
    const control = new SessionControl(null);
    const page = {
      url: () => "https://app.example/",
      evaluateHandle: async () => {
        const held = {
          outcome: {
            url: "https://app.example/logo.png",
            status: 200,
            ok: true,
            contentType: "image/png",
            kind: "binary",
            text: "",
            truncated: false,
            size: 1,
          },
          body: Uint8Array.of(9),
        };
        return {
          evaluate: async (
            read: (value: typeof held, range?: readonly [number, number]) => unknown,
            range?: readonly [number, number],
          ) => read(held, range),
          dispose: async () => undefined,
        };
      },
      context: () => ({ cookies: async () => [] }),
    };
    // A human-driven tab: the server observes around the whole operation, as ServerBrowser does.
    const outer = control.observe(async () => {
      const result = await inPageFetch(page as unknown as Page, control, { url: "/logo.png" });
      control.setPrivate(true);
      control.setPrivate(false);
      return result;
    });
    await expect(
      outer.then((result) => publishFetchedBody(dir, result, Infinity)),
    ).rejects.toMatchObject({
      reason: "privateMode",
    });
    expect(NodeFS.existsSync(dir) ? await NodeFSP.readdir(dir) : []).toEqual([]);
  }));
