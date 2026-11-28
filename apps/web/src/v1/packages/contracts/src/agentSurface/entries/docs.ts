import { entry } from "../entry.ts";

const GUIDE =
  "The guides are GOAT's user documentation as this server's build ships it. url opens the page on trygoat.ai, which shows the latest published guide and can differ from this build; cite the guide title, section and build.";

export const docsEntries = {
  "docs.search": entry({
    resource: "docs",
    verb: "search",
    name: "goat_docs_search",
    toolkit: "docs",
    summary: "Search GOAT's user guides for how a feature, setting or error works.",
    description:
      "Search GOAT's user guides, ranked by section. Use it first for questions about GOAT itself: features, settings, setup, connections and errors. Then read the best match with goat_docs_read.",
    guide:
      "Words are matched case-insensitively; filler words are dropped. A section ranks higher when its heading or page title holds the words. total and truncated say how many sections matched beyond limit. " +
      GUIDE,
    parameters: {
      query: "2-6 essential words, such as 'tailscale https'.",
      limit: "Sections to return, 1 to 25. Default 8.",
    },
    examples: [
      { title: "Find how to reach GOAT over Tailscale", args: { query: "tailscale https" } },
    ],
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: true, openWorldHint: false },
  }),
  "docs.read": entry({
    resource: "docs",
    verb: "read",
    name: "goat_docs_read",
    toolkit: "docs",
    summary: "Read one GOAT user guide or section; without a page, list every guide.",
    description:
      "Read a GOAT user guide by page id, or one section of it by heading or anchor. Without page, list every guide. Long reads end with truncated and nextCursor.",
    guide:
      "A whole-page read lists the page's sections; pass one back as section to read only it. Continue a truncated read with nextCursor and the same page and section. " +
      GUIDE,
    parameters: {
      page: "Guide id from goat_docs_search or the guide list, such as 'remote-access'.",
      section: "A section heading or its anchor, such as 'tailscale-https'.",
      cursor: "nextCursor from the previous read of the same page and section.",
    },
    examples: [
      { title: "Read one section", args: { page: "remote-access", section: "tailscale-https" } },
      { title: "List every guide", args: {} },
    ],
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: true, openWorldHint: false },
  }),
} as const;
