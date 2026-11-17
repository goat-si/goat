import type { ComponentProps } from "react";
import { ThreadId } from "@goat/contracts";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import "~/index.css";

import type { MessagesTimeline } from "./MessagesTimeline";
import {
  CREATED_AT,
  ENVIRONMENT_ID,
  click,
  renderElement,
  renderTimeline,
  type Entry,
} from "./MessagesTimeline.browserHarness";
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
    useAssetUrls: ((...args: Parameters<typeof actual.useAssetUrls>) =>
      stubbedAsset.url
        ? args[1].map(() => stubbedAsset.url)
        : actual.useAssetUrls(...args)) as typeof actual.useAssetUrls,
  };
});

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function work(id: string, entry: Record<string, unknown>): Entry {
  return {
    id,
    kind: "work",
    createdAt: CREATED_AT,
    entry: { id, createdAt: CREATED_AT, ...entry },
  } as Entry;
}

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
  it("opens an image from an expanded tool row as a gallery of the turn's viewed images", async () => {
    stubbedAsset.url = PIXEL;
    onTestFinished(() => {
      stubbedAsset.url = "";
    });
    const onImageExpand = vi.fn<ComponentProps<typeof MessagesTimeline>["onImageExpand"]>();
    const read = (name: string) =>
      work(`read-${name}`, {
        label: `Read ${name}`,
        toolTitle: "Read",
        tone: "tool",
        itemType: "dynamic_tool",
        toolLifecycleStatus: "completed",
        viewedImagePath: `/repo/${name}`,
      });
    await using screen = await renderTimeline(
      [read("first.png"), read("second.png"), read("third.png")],
      { onImageExpand, workspaceRoot: "/repo" },
    );
    await click(screen.button(/^Read 3 files/));
    await vi.waitFor(() => expect(screen.buttons("Read")).toHaveLength(3));
    await click(screen.buttons("Read")[1]!);
    const inRow = await vi.waitFor(() => {
      const image = [...screen.container.querySelectorAll("img")].find(
        (img) => img.alt === "second.png" && !img.closest("[data-image-gallery]"),
      );
      expect(image).toBeTruthy();
      return image!;
    });
    await click(inRow.closest<HTMLElement>("button, [role=button]")!);
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
