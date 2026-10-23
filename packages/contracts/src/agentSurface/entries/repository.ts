import { entry } from "../entry.ts";

export const repositoryEntries = {
  "repository.snapshot": entry({
    resource: "repository",
    verb: "snapshot",
    name: "goat_repository_snapshot",
    toolkit: "project",
    summary:
      "Read a bounded content snapshot of explicitly named tracked files in a registered repository.",
    description:
      "Read committed text from exact files in a registered repository matched by canonical origin key. Pin a local commit or HEAD, including unpushed commits; uncommitted edits are excluded. Snapshot data grants no source filesystem or host credentials and leaves ambient permissions unchanged.",
    guide:
      "Capture requires live reauthorization of an existing filesystem:read grant or full-access/default authority. Set mode to snapshot; runtime filesystem/root grants and writes are unsupported. This tool never fetches or installs.\n\nName exact relative files. Symlinks, submodules, secret paths or content, binary content, and oversized content are refused. Request up to 8 files, at most 16 KiB each and 32 KiB total.\n\nRemote reads retain caller ceilings and require a ready host implementing goat_repository_snapshot.",
    effect: "read",
    hostRoutable: true,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: true, openWorldHint: false },
  }),
} as const;
