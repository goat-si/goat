import type { PreviewAutomationSnapshot } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";
import { saveScreenshot } from "../../previewScreenshotFile.ts";
import {
  boundSnapshotMetadata,
  cutText,
  MAX_SNAPSHOT_IDENTIFIER_CHARS,
  recordSnapshotDelivery,
  snapshotDeliveryKey,
  type SnapshotMetadata,
  withDeliveredBaseline,
} from "./snapshotTransport.ts";

const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const snapshotResult = Effect.fn("PreviewSnapshot.result")(function* (
  encodedResult: unknown,
  payload: { readonly save?: unknown; readonly includeImage?: unknown } | undefined,
  invocation: unknown,
) {
  const snapshot = encodedResult as SnapshotMetadata & {
    readonly url: string;
    readonly screenshot: PreviewAutomationSnapshot["screenshot"];
    readonly fullScreenshot?: { readonly data: string };
  };
  const { screenshot, fullScreenshot, ...page } = snapshot;
  const { data = "", ...screenshotMetadata } = screenshot ?? {};
  const png = new Uint8Array(Buffer.from(data, "base64"));
  const saving = payload?.save === true && screenshot !== undefined;
  const screenshotPath = saving
    ? yield* saveScreenshot(
        snapshot.url,
        fullScreenshot === undefined
          ? png
          : new Uint8Array(Buffer.from(fullScreenshot.data, "base64")),
      )
    : undefined;
  const deliveryKey = snapshotDeliveryKey(invocation, snapshot.tabId);
  // Images stay out of tool history unless asked for: providers replay them on every
  // later request, and some reject inline images outright.
  const includeImage = payload?.includeImage === true;
  if (screenshotPath !== undefined && !includeImage) {
    recordSnapshotDelivery(deliveryKey, true);
    const saved = {
      url: cutText(snapshot.url, MAX_SNAPSHOT_IDENTIFIER_CHARS),
      screenshotPath,
      ...(screenshot?.fullPage ? { screenshot: screenshotMetadata } : {}),
    };
    return new McpSchema.CallToolResult({
      isError: false,
      structuredContent: saved,
      content: [{ type: "text", text: encodeJsonText(saved) }],
    });
  }
  const metadata = withDeliveredBaseline(deliveryKey, {
    ...page,
    ...(screenshot ? { screenshot: screenshotMetadata } : {}),
    ...(screenshotPath === undefined ? {} : { screenshotPath }),
  });
  const bounded = boundSnapshotMetadata(metadata);
  recordSnapshotDelivery(deliveryKey, bounded.treeCut);
  return new McpSchema.CallToolResult({
    isError: false,
    // Codex would send the model this JSON in place of the image (see imageToolSuccess).
    ...(includeImage
      ? {}
      : {
          structuredContent: bounded.value,
        }),
    content: [
      {
        type: "text",
        text: encodeJsonText({
          url: cutText(snapshot.url, MAX_SNAPSHOT_IDENTIFIER_CHARS),
        }),
      },
      { type: "text", text: bounded.text },
      ...(bounded.logNote === undefined ? [] : [{ type: "text" as const, text: bounded.logNote }]),
      ...(bounded.omitted.length === 0
        ? []
        : [
            {
              type: "text" as const,
              text: `Snapshot text was bounded. Omitted: ${bounded.omitted.join("; ")}.`,
            },
          ]),
      ...(includeImage && screenshot
        ? [{ type: "image" as const, data: png, mimeType: screenshot.mimeType }]
        : []),
    ],
  });
});
