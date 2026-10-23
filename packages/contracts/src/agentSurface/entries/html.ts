import {
  htmlPreviewDescription,
  htmlPreviewGuide,
  htmlRenderDescription,
  htmlRenderGuide,
} from "../html.ts";
import { entry } from "../entry.ts";

export const htmlEntries = {
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
    description: htmlRenderDescription,
    guide: htmlRenderGuide,
    effect: "write",
    capability: "none",
    capabilityReason: "Renders into the calling thread only.",
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
