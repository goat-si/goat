import {
  htmlPreviewDescription,
  htmlPreviewGuide,
  htmlRenderDescription,
  htmlRenderGuide,
} from "../html.ts";
import { entry } from "../entry.ts";

export const htmlEntries = {
  "html.list": entry({
    resource: "html",
    verb: "list",
    name: "goat_html_list",
    toolkit: "html",
    summary: "List saved HTML pages",
    description:
      "List this thread's saved HTML pages with attachment ids, environment-local paths, sizes and modification times. Use this to reconcile an html.render whose response was lost, even before its tool result appears in thread activity.",
    guide:
      "Inspect the returned environment-local files to identify the page before deciding to publish again. This lists saved files, not only pages the provider reported. Pages are ordered by attachment id; continue with nextCursor until null. The list reflects live files, so pages may disappear between reads.",
    effect: "read",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: true, openWorldHint: false },
  }),
  "html.preview": entry({
    resource: "html",
    verb: "preview",
    name: "html_preview",
    toolkit: "html",
    summary: "Preview HTML",
    description: htmlPreviewDescription,
    guide: htmlPreviewGuide,
    effect: "read",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "Preview HTML",
      idempotentHint: true,
      openWorldHint: true,
    },
  }),
  "html.render": entry({
    resource: "html",
    verb: "render",
    name: "html_render",
    toolkit: "html",
    summary: "Render HTML",
    description: `${htmlRenderDescription} Retry with the same clientRequestId to avoid publishing another page.`,
    guide: htmlRenderGuide,
    effect: "write",
    capability: "none",
    capabilityReason: "Renders into the calling thread only.",
    idempotency: "key",
    reconcile: "html.list",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "Render HTML",
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
} as const;
