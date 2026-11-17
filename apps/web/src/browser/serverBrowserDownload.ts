import type { PreviewStreamDownload } from "@goat/client-runtime/preview/server-browser-stream";

import { toastManager } from "~/components/ui/toast";

export function offerDownload(download: PreviewStreamDownload) {
  const id = toastManager.add({
    type: "info",
    title: `Downloaded ${download.fileName}`,
    actionProps: {
      children: "Save",
      onClick: () => {
        toastManager.close(id);
        const anchor = document.createElement("a");
        anchor.href = download.url;
        anchor.download = download.fileName;
        anchor.click();
      },
    },
  });
}
