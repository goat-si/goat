import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import { ASSET_ROUTE_PREFIX, issueAssetUrl, resolveAsset } from "./AssetAccess.ts";
import { layerTest, screenshotPng } from "./AssetAccess.testkit.ts";

it.effect("ignores a client-named document type for image attachments", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const attachmentId = "thread-1-00000000-0000-4000-8000-000000000003";
    const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.png`);
    yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
    yield* fileSystem.writeFile(attachmentPath, screenshotPng);

    const result = yield* issueAssetUrl({
      resource: { _tag: "attachment", attachmentId, mimeType: "text/html" },
    });
    const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
    const separatorIndex = suffix.indexOf("/");

    expect(
      yield* resolveAsset(suffix.slice(0, separatorIndex), suffix.slice(separatorIndex + 1)),
    ).toEqual({ kind: "file", path: attachmentPath });
  }).pipe(Effect.provide(layerTest)),
);
