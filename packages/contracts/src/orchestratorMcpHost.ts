import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Another machine's SSH host alias. Threads are keyed by (host, threadId): a
 * thread id belongs to the environment that created it.
 */
export const OrchestratorMcpHost = TrimmedNonEmptyString.check(Schema.isMaxLength(255)).annotate({
  description:
    "Another machine: an SSH host alias from goat_ssh_host_list, a linked host name from goat_host_link_list, or the host goat_ssh_thread_launch returned. Omit for this environment.",
});
