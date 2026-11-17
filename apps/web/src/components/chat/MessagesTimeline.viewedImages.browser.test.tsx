import type { ComponentProps } from "react";
import { ThreadId } from "@goat/contracts";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import "~/index.css";

import type MessagesTimeline from "./MessagesTimeline";
import { CREATED_AT, ENVIRONMENT_ID, renderElement } from "./MessagesTimeline.browserHarness";
import { ViewedImagesTimelineRow } from "./TimelineWorkEntryRow";
import { TimelineRowCtx } from "./timelineRowContext";

const stubbedAsset = vi.hoisted(() => ({ url: "" }));
vi.mock(import("~/assets/assetUrls"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useAssetUrlState: ((...args: Parameters<typeof actual.useAssetUrlState>) =>
      stubbedAsset.url
        ? { _tag: "Success", url: stubbedAsset.url }
        : actual.useAssetUrlState(...args)) as typeof actual.useAssetUrlState,
  };
});

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("images an agent viewed", () => {
  it("opens a viewed image as a gallery of the images beside it", async () => {
    stubbedAsset.url = PIXEL;
    onTestFinished(() => {
      stubbedAsset.url = "";
    });
    const onImageExpand = vi.fn<ComponentProps<typeof MessagesTimeline>["onImageExpand"]>();
    await using screen = await renderElement(
      <TimelineRowCtx
        value={
          {
            threadRef: { environmentId: ENVIRONMENT_ID, threadId: ThreadId.make("thread-1") },
            workspaceRoot: "/repo",
            onImageExpand,
          } as never
        }
      >
        <ViewedImagesTimelineRow
          row={{
            kind: "viewed-images",
            id: "viewed",
            createdAt: CREATED_AT,
            paths: ["/repo/first.png", "/repo/second.png", "/repo/third.png"],
          }}
        />
      </TimelineRowCtx>,
    );
    await screen.getByRole("button", { name: "Preview second.png" }).click();
    expect(onImageExpand).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        index: 1,
        images: ["first.png", "second.png", "third.png"].map((name) =>
          expect.objectContaining({ name }),
        ),
      }),
    );
  });
});
