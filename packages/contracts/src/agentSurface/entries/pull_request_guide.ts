import { entry } from "../entry.ts";

export const pullRequestGuideEntries = {
  "pull_request_guide.update": entry({
    resource: "pull_request_guide",
    verb: "update",
    name: "write_pull_request_guides",
    toolkit: "pullRequests",
    summary: "Write pull request guides",
    description:
      "Start writing pull request review guides in the background. Read progress with goat_pull_request_guide_read. A running guide for the same head is reused; a completed guide for that head is generated again.",
    guide:
      "Accepts up to 20 pull requests. Each guide is a maintainer’s tour shown in the pull request’s Guide tab. Generation reads the change in a temporary checkout and takes minutes; the response returns after runs start. Each target must match a project checkout in this environment. Review guides must be enabled on the server.",
    effect: "write",
    capability: "threads.launch",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "Write pull request guides",
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "pull_request_guide.read": entry({
    resource: "pull_request_guide",
    verb: "read",
    name: "read_pull_request_guide",
    toolkit: "pullRequests",
    summary: "Read pull request guide",
    description:
      "Read a pull request’s stored review guide and generation status. A stale guide describes an older head; this call does not start generation.",
    guide:
      "run has tag Running while generation is active and Failed with details when the last run failed. guide is null when no guide is stored. stale compares the guide head to the currently known host head; if no current head is available, it is false rather than proof the guide is current.",
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "Read pull request guide",
      idempotentHint: true,
      openWorldHint: true,
    },
  }),
} as const;
