import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import { ASSET_ROUTE_PREFIX, issueAssetUrl, resolveAsset } from "./AssetAccess.ts";
import { layerTest } from "./AssetAccess.testkit.ts";

it.effect("reports a pruned attachment as missing to new and existing readers", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
    const attachmentId = "thread-1-00000000-0000-4000-8000-000000000099-xml";
    const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.xml`);
    yield* fs.writeFileString(attachmentPath, "evidence");
    const resource = { _tag: "attachment" as const, attachmentId };
    const issued = yield* issueAssetUrl({ resource });
    const suffix = issued.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
    const separator = suffix.indexOf("/");
    yield* fs.remove(attachmentPath);
    expect(yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1))).toBeNull();
    const error = yield* issueAssetUrl({ resource }).pipe(Effect.flip);
    expect(error._tag).toBe("AssetAttachmentNotFoundError");
  }).pipe(Effect.provide(layerTest)),
);
