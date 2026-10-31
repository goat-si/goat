import { ComposerContextId } from "@goat/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  decodeComposerContextFragment,
} from "@goat/shared/composerContextClipboard";
import { collectComposerContextReferences } from "@goat/shared/composerContextReferences";
import { describe, expect, it, vi } from "vite-plus/test";
import "~/index.css";
import { MessagesTimeline } from "./MessagesTimeline";
import { baseProps, click, message, renderTimeline } from "./MessagesTimeline.browserHarness";

describe("user message attachment copy and labels", () => {
  it("labels pasted text while its file is sending", async () => {
    await using screen = await renderTimeline([
      message("", {
        attachments: [
          {
            type: "file",
            id: "pasted",
            name: "paste.txt",
            mimeType: "text/plain",
            sizeBytes: 12,
            downloadable: false,
            source: { _tag: "pasted-text" },
          },
        ],
      }),
    ]);
    await expect.element(screen.getByText("Pasted text · Sending…")).toBeVisible();
  });

  it.each(["image", "file"] as const)(
    "copies only matching context records for a wordless %s attachment",
    async (kind) => {
      const attachment = {
        type: kind,
        id: "media",
        name: kind === "image" ? "photo.png" : "clip.mp4",
        mimeType: kind === "image" ? "image/png" : "video/mp4",
        sizeBytes: 100,
        downloadable: false,
      };
      const record = {
        version: 1 as const,
        ...(kind === "image" ? { kind: "image" as const } : { kind: "file" as const }),
        contextId: ComposerContextId.make("media-context"),
        label: attachment.name,
        attachmentId: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      };
      await using screen = await renderTimeline([message("", { attachments: [attachment] })]);
      expect(screen.buttons("Copy message")).toHaveLength(0);
      await screen.rerender(
        <MessagesTimeline
          {...baseProps()}
          timelineEntries={[
            message("", {
              attachments: [attachment],
              context: { version: 1, records: [{ ...record, attachmentId: "other" }] },
            }),
          ]}
        />,
      );
      expect(screen.buttons("Copy message")).toHaveLength(0);
      await screen.rerender(
        <MessagesTimeline
          {...baseProps()}
          timelineEntries={[
            message("", {
              attachments: [attachment],
              context: {
                version: 1,
                records: [
                  record,
                  {
                    ...record,
                    contextId: ComposerContextId.make("other-context"),
                    attachmentId: "other",
                  },
                ],
              },
            }),
          ]}
        />,
      );
      using write = vi.spyOn(navigator.clipboard, "write").mockResolvedValue();
      await click(screen.button("Copy message"));
      await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
      const [item] = write.mock.calls[0]![0];
      const text = await (await item!.getType("text/plain")).text();
      const fragment = await (await item!.getType(COMPOSER_CONTEXT_CLIPBOARD_MIME)).text();
      expect(
        collectComposerContextReferences(text).map((reference) => reference.contextId),
      ).toEqual([record.contextId]);
      expect(decodeComposerContextFragment(fragment)?.records).toEqual([record]);
    },
  );
});
