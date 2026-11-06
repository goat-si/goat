import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { AssetCreateUrlInput, AssetPreviewTypeValidationError } from "@goat/contracts";
import { symlinksSupported } from "@goat/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpServerResponse } from "effect/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { assetFileResponse } from "../http.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { ASSET_ROUTE_PREFIX, resolveAsset } from "./AssetAccess.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";
import { issueNoteFileUrl } from "./noteFileAsset.ts";

const layerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "goat-note-file-asset-",
});
const layerTest = Layer.mergeAll(
  NodeHttpPlatform.layer,
  layerConfig,
  WorkspacePaths.layer,
  ServerSecretStore.layer.pipe(Layer.provide(layerConfig)),
  // Required by issueAssetUrl's other resources; note files never reach them.
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
  Layer.mock(NativeAppIconResolver.NativeAppIconResolver)({}),
).pipe(Layer.provideMerge(NodeServices.layer));

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isInput = Schema.is(AssetCreateUrlInput);

const issue = (path: string, disposition?: "attachment") =>
  Effect.gen(function* () {
    const result = yield* issueNoteFileUrl({
      _tag: "note-file",
      path,
      ...(disposition ? { disposition } : {}),
    });
    const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
    const separator = suffix.indexOf("/");
    return yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1));
  });

const attachment = (name: string, bytes: string | Uint8Array) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* ServerConfig.ServerConfig;
    yield* fs.makeDirectory(`${notesDir}/.attachments`, { recursive: true });
    const file = `${notesDir}/.attachments/${name}`;
    if (typeof bytes === "string") yield* fs.writeFileString(file, bytes);
    else yield* fs.writeFile(file, bytes);
    return { path: `.attachments/${name}`, file: yield* fs.realPath(file) };
  });

describe("note file assets", () => {
  it.effect("serves embedded media inline and other files only as downloads", () =>
    Effect.gen(function* () {
      for (const [name, bytes] of [
        ["0123456789abcdef.png", png],
        ["0123456789abcde1.mp4", "video"],
        ["0123456789abcde2.pdf", "%PDF-1.7"],
      ] as const) {
        const file = yield* attachment(name, bytes);
        expect(yield* issue(file.path)).toMatchObject({ kind: "file", path: file.file });
      }
      const svg = yield* attachment(
        "0123456789abcde3.svg",
        "<svg xmlns='http://www.w3.org/2000/svg'/>",
      );
      const svgAsset = yield* issue(svg.path);
      if (svgAsset?.kind !== "file") throw new Error("Expected an SVG file");
      const svgResponse = HttpServerResponse.toWeb(yield* assetFileResponse(svgAsset));
      expect(svgResponse.headers.get("content-security-policy")).toContain("sandbox");

      const archive = yield* attachment("0123456789abcde4.zip", "zip bytes");
      expect(yield* issue(archive.path).pipe(Effect.flip)).toBeInstanceOf(
        AssetPreviewTypeValidationError,
      );
      const download = yield* issue(archive.path, "attachment");
      expect(download).toMatchObject({
        kind: "file",
        download: true,
        mimeType: "application/octet-stream",
      });
      if (download?.kind !== "file") throw new Error("Expected a download");
      const response = HttpServerResponse.toWeb(yield* assetFileResponse(download));
      expect(response.headers.get("content-disposition")).toContain("attachment;");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("reports a missing file against the note resource", () =>
    Effect.gen(function* () {
      const error = yield* issue(".attachments/fedcba9876543210.png").pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "AssetWorkspaceAssetNotFoundError",
        resource: { _tag: "note-file", path: ".attachments/fedcba9876543210.png" },
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it("admits only attachment folder paths", () => {
    for (const path of [".git/config", "../x.png", "note.md", ".attachments/../note.md"])
      expect(isInput({ resource: { _tag: "note-file", path } })).toBe(false);
    expect(
      isInput({ resource: { _tag: "note-file", path: ".attachments/0123456789abcdef.png" } }),
    ).toBe(true);
  });

  it.effect.skipIf(!symlinksSupported)("refuses a linked attachment folder or file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { notesDir } = yield* ServerConfig.ServerConfig;
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "goat-note-files-outside-" });
      yield* fs.writeFileString(`${outside}/0123456789abcdef.png`, "outside");
      yield* fs.makeDirectory(`${notesDir}/.attachments`, { recursive: true });
      yield* fs.symlink(
        `${outside}/0123456789abcdef.png`,
        `${notesDir}/.attachments/0123456789abcdef.png`,
      );
      expect((yield* issue(".attachments/0123456789abcdef.png").pipe(Effect.flip))._tag).toBe(
        "AssetWorkspaceAssetNotFoundError",
      );
      yield* fs.remove(`${notesDir}/.attachments`, { recursive: true });
      yield* fs.symlink(outside, `${notesDir}/.attachments`);
      expect((yield* issue(".attachments/0123456789abcdef.png").pipe(Effect.flip))._tag).toBe(
        "AssetWorkspaceAssetNotFoundError",
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
