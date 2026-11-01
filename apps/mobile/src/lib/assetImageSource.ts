import { LEGACY_ATTACHMENT_CACHE_PREFIX } from "@goat/contracts/legacyT3Names";
import type { AssetResource, EnvironmentId } from "@goat/contracts";
import type { ImageSource } from "expo-image";

/** Cache immutable attachments by id; signed URLs change on each mint and reconnect. */
export function assetImageSource(
  environmentId: EnvironmentId,
  resource: AssetResource,
  uri: string,
): ImageSource {
  return resource._tag === "attachment"
    ? {
        uri,
        cacheKey: `${LEGACY_ATTACHMENT_CACHE_PREFIX}${JSON.stringify([environmentId, resource.attachmentId])}`,
      }
    : { uri };
}
