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
      "Read committed text from a registered repository matched by canonical origin key. Capturing requires live reauthorization of an existing filesystem:read grant or full-access/default authority. mode must be snapshot; filesystem/root grants and writes are unsupported. Pin an exact local commit or current HEAD, including unpushed work; never fetch or install. Exact relative files only: symlinks, submodules, secret paths/content, binary and oversized content are refused. Up to 8 files, 16 KiB each and 32 KiB total. The returned data grants no source filesystem or host credential to a worker and does not restrict pre-existing ambient permissions. Remote reads use existing caller ceilings and require a ready host implementing this tool.",
    effect: "read",
    hostRoutable: true,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: true, openWorldHint: false },
  }),
} as const;
