import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ToastProvider } from "../ui/toast";
import { useQueuedSendDelivery, useSendAfterUploads } from "./useSendAfterUploads";

function Composer(props: {
  readonly uploadsPending: boolean;
  readonly uploadFailed: boolean;
  readonly send: () => void;
}) {
  const queue = useSendAfterUploads("thread-a", {
    canQueue: props.uploadsPending,
    uploadsPending: props.uploadsPending,
    uploadFailed: props.uploadFailed,
  });
  useQueuedSendDelivery(queue, props.send);
  return (
    <button type="button" onClick={(event) => queue.intercept(event, false)}>
      {queue.queued ? "Locked" : "Send"}
    </button>
  );
}

const mount = (props: Parameters<typeof Composer>[0]) => (
  <ToastProvider>
    <Composer {...props} />
  </ToastProvider>
);

it("sends once the uploads finish and keeps the composer locked until then", async () => {
  const send = vi.fn();
  await using screen = await render(mount({ uploadsPending: true, uploadFailed: false, send }));
  await userEvent.click(page.getByRole("button", { name: "Send" }));
  await expect.element(page.getByRole("button", { name: "Locked" })).toBeVisible();
  await expect.element(page.getByText("Sending after upload…")).toBeVisible();
  expect(send).not.toHaveBeenCalled();
  await screen.rerender(mount({ uploadsPending: false, uploadFailed: false, send }));
  await expect.element(page.getByRole("button", { name: "Send" })).toBeVisible();
  expect(send).toHaveBeenCalledOnce();
});

it("unlocks with the message intact and sends nothing when an upload fails", async () => {
  const send = vi.fn();
  await using screen = await render(mount({ uploadsPending: true, uploadFailed: false, send }));
  await userEvent.click(page.getByRole("button", { name: "Send" }));
  await screen.rerender(mount({ uploadsPending: false, uploadFailed: true, send }));
  await expect.element(page.getByRole("button", { name: "Send" })).toBeVisible();
  expect(send).not.toHaveBeenCalled();
});

it("unlocks as soon as one upload fails, even while another is still uploading", async () => {
  const send = vi.fn();
  await using screen = await render(mount({ uploadsPending: true, uploadFailed: false, send }));
  await userEvent.click(page.getByRole("button", { name: "Send" }));
  await screen.rerender(mount({ uploadsPending: true, uploadFailed: true, send }));
  await expect.element(page.getByRole("button", { name: "Send" })).toBeVisible();
  await screen.rerender(mount({ uploadsPending: false, uploadFailed: true, send }));
  expect(send).not.toHaveBeenCalled();
});

it("cancels a queued send from its notice", async () => {
  const send = vi.fn();
  await using screen = await render(mount({ uploadsPending: true, uploadFailed: false, send }));
  await userEvent.click(page.getByRole("button", { name: "Send" }));
  await userEvent.click(page.getByRole("button", { name: "Cancel" }));
  await expect.element(page.getByRole("button", { name: "Send" })).toBeVisible();
  await screen.rerender(mount({ uploadsPending: false, uploadFailed: false, send }));
  expect(send).not.toHaveBeenCalled();
});
