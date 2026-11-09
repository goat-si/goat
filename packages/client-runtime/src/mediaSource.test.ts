import { EnvironmentId, ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { BearerConnectionTarget, SshConnectionTarget } from "./connection/model.ts";
import { resolveMediaSource } from "./mediaSource.ts";

const threadId = ThreadId.make("thread-1");
const remote = { environmentId: EnvironmentId.make("environment-1"), label: "Build box" };
const normalizeUri = (uri: string) => (uri.startsWith("//") ? `http:${uri}` : uri);
const bearerEnvironment = {
  connection: {
    target: new BearerConnectionTarget({ ...remote, connectionId: "saved:box" }),
    httpBaseUrl: "http://100.65.180.100:3773",
  },
  isDesktopRenderer: false,
  normalizeUri,
};

describe("resolveMediaSource", () => {
  describe("direct URLs", () => {
    it.each(["https://cdn.example.com/tone.mp3", "data:audio/wav;base64,AAAA"])(
      "keeps %s out of the image and video viewer",
      (href) => {
        expect(resolveMediaSource(href, { threadId })).toBeNull();
        expect(resolveMediaSource(href, { threadId, imageEmbed: true })).toBeNull();
      },
    );

    it("keeps the authored URL and decodes the display name once", () => {
      const href = "https://cdn.example.com/clip%20one%2520%2Emp4?signature=a%2fb#t=2";
      expect(resolveMediaSource(href, { threadId })).toEqual({
        kind: "video",
        mimeType: "video/mp4",
        name: "clip one%20.mp4",
        reference: { kind: "url", url: href },
        srcFragment: "#t=2",
        access: "direct",
        uri: href,
      });
    });

    it("accepts extensionless image embeds only when asked", () => {
      const href = "https://cdn.example.com/render?id=42";
      expect(resolveMediaSource(href, { threadId })).toBeNull();
      expect(resolveMediaSource(href, { threadId, imageEmbed: true })).toMatchObject({
        kind: "image",
        mimeType: "image/*",
        name: "render",
      });
    });

    it("loads a remote environment's localhost media from the environment's address (regression: loaded this device's localhost)", () => {
      const href = "http://localhost:5173/shot.png";
      expect(
        resolveMediaSource(href, { threadId, environmentConnection: bearerEnvironment }),
      ).toMatchObject({
        access: "direct",
        uri: "http://100.65.180.100:5173/shot.png",
        reference: { kind: "url", url: href },
      });
    });

    it("routes a protocol-relative localhost image after this client's scheme rule", () => {
      expect(
        resolveMediaSource("//localhost:5173/a.png", {
          threadId,
          environmentConnection: bearerEnvironment,
        }),
      ).toMatchObject({ access: "direct", uri: "http://100.65.180.100:5173/a.png" });
    });

    it("reports why a remote environment's localhost media is out of this device's reach", () => {
      expect(
        resolveMediaSource("http://localhost:5173/clip.mp4", {
          threadId,
          environmentConnection: {
            connection: {
              target: new SshConnectionTarget({ ...remote, connectionId: "ssh:box" }),
              httpBaseUrl: "http://127.0.0.1:41234",
            },
            isDesktopRenderer: false,
            normalizeUri,
          },
        }),
      ).toMatchObject({
        kind: "video",
        access: "unavailable",
        reason: expect.stringContaining("localhost:5173 is on Build box"),
      });
    });
  });

  describe("host paths", () => {
    it.each(["tone.wav", "tone.mp3", "tone.oga", "tone.webm-audio"])(
      "keeps workspace audio %s out of the image fallback",
      (path) => {
        expect(resolveMediaSource(path, { threadId, imageEmbed: true })).toBeNull();
        expect(
          resolveMediaSource("authored.wav", {
            threadId,
            imageEmbed: true,
            resolvedFilePath: path,
          }),
        ).toBeNull();
      },
    );

    it.each([
      ["/tmp/frame%23one.png:12", "/tmp/frame#one.png"],
      ["/tmp/frame%2523one.png:12", "/tmp/frame%23one.png"],
    ])("resolves %s through the environment", (href, path) => {
      expect(resolveMediaSource(href, { threadId, workspaceRoot: "/repo" })).toEqual({
        kind: "image",
        mimeType: "image/png",
        name: path.split(/[\\/]/).at(-1),
        reference: { kind: "file", path },
        srcFragment: "",
        access: "environment",
        resource: { _tag: "media-file", threadId, path },
      });
    });

    it("joins relative paths to the workspace and records the relative reference", () => {
      expect(
        resolveMediaSource("screens/logo.svg?v=2#mark", { threadId, workspaceRoot: "/repo" }),
      ).toEqual({
        kind: "image",
        mimeType: "image/svg+xml",
        name: "logo.svg",
        reference: {
          kind: "file",
          path: "/repo/screens/logo.svg",
          relativePath: "screens/logo.svg",
        },
        srcFragment: "#mark",
        access: "environment",
        resource: { _tag: "media-file", threadId, path: "/repo/screens/logo.svg" },
      });
    });

    it("prefers a caller-resolved path over classifying the source", () => {
      expect(
        resolveMediaSource("logo.svg", {
          threadId,
          workspaceRoot: "/repo",
          resolvedFilePath: "/repo/docs/logo.svg",
        }),
      ).toMatchObject({
        access: "environment",
        resource: { _tag: "media-file", path: "/repo/docs/logo.svg" },
        reference: { relativePath: "docs/logo.svg" },
      });
    });

    it("separates a playback fragment from literal filename characters", () => {
      expect(resolveMediaSource("/tmp/clip%23one.mp4#t=2", { threadId })).toMatchObject({
        kind: "video",
        srcFragment: "#t=2",
        resource: { path: "/tmp/clip#one.mp4" },
      });
    });

    it("cannot be loaded without a thread to mint through", () => {
      expect(resolveMediaSource("/tmp/clip.mp4", { threadId: undefined })).toMatchObject({
        kind: "video",
        access: "unavailable",
      });
    });
  });
});
