import { entry } from "../entry.ts";

export const pullRequestGuideEntries = {
  "pull_request_guide.update": entry({
    resource: "pull_request_guide",
    verb: "update",
    name: "write_pull_request_guides",
    toolkit: "pullRequests",
    summary: "Write pull request guides",
    description:
      "Write review guides for up to 20 pull requests, the tour a maintainer reads in a pull request's Guide tab. Each run reads its change in a temporary checkout and takes minutes, so this returns once the runs are under way; read a guide with goat_pull_request_guide_read to see when it is written. A guide for the same head that is already running is joined, not restarted; a pull request whose guide is current is written again. Each pull request is read through the project in this environment whose checkout has that repository. Fails while review guides are off on this server.",
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
      "Read a pull request's stored review guide and its run: run.Running while one is being written, run.Failed with the reason when the last one failed, guide null when none was written. stale is true after a push the guide has not caught up with. Never starts a run.",
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
