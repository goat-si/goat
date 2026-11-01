import type { ThreadId } from "@goat/contracts";
import { resolveProjectSettings } from "@goat/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ServerSettings from "../../../serverSettings.ts";

/**
 * Whether a thread's agent may drive devices now. A credential's device
 * capability reflects the settings when it was issued; this reads the thread's
 * project-resolved Agent device access at each call, so a project grant works
 * with the environment default off and a revocation reaches running agents.
 * A thread or project that cannot be found, or cannot be read, is refused.
 */
export const threadDeviceAccess = Effect.fn("threadDeviceAccess")(
  function* (threadId: ThreadId) {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const shell = yield* threads.getThreadShell(threadId);
    if (shell === null) return false;
    const projects = yield* ProjectService.ProjectService;
    if (Option.isNone(yield* projects.getById(shell.projectId))) return false;
    const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
    return resolveProjectSettings(settings, shell.projectId).settings.enableAgentDeviceAccess;
  },
  (effect, threadId) =>
    effect.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not resolve agent device access; refusing device tools.", {
          threadId,
          cause,
        }).pipe(Effect.as(false)),
      ),
    ),
);
