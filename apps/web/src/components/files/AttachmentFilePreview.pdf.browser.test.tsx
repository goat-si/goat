import { EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn<() => Promise<string | null>>() }));
vi.mock(import("~/assets/assetUrls"), async (original) => {
  const callbacks = new WeakMap<object, () => Promise<string | null>>();
  return {
    ...(await original()),
    useAssetUrlRefresh: (_environmentId, resource) => {
      if (!resource) return refresh;
      let callback = callbacks.get(resource);
      if (!callback) callbacks.set(resource, (callback = () => refresh()));
      return callback;
    },
    useAssetUrlState: () => ({ _tag: "Loading" as const }),
  };
});
import { AttachmentFilePreview } from "./AttachmentFilePreview";

it("keeps an attachment URL when the parent passes the same attachment in a fresh object", async () => {
  const url = URL.createObjectURL(new Blob(["%PDF-1.4"], { type: "application/pdf" }));
  refresh.mockReset().mockResolvedValue(url);
  const preview = () => (
    <AttachmentFilePreview
      name="report.pdf"
      mimeType="application/pdf"
      sizeBytes={8}
      asset={{ environmentId: EnvironmentId.make("test"), attachmentId: "report" }}
    />
  );
  try {
    await using screen = await render(preview());
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await screen.rerender(preview());
    expect(refresh).toHaveBeenCalledTimes(1);
  } finally {
    URL.revokeObjectURL(url);
  }
});
