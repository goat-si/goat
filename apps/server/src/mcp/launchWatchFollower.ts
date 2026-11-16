import type { RunId } from "@goat/contracts";

import type { LaunchWatchTerminalStatus } from "./launchWatch.ts";

/** What one follower step learned about the run it follows. */
export type StepResult =
  | {
      readonly _tag: "Terminal";
      readonly status: LaunchWatchTerminalStatus;
      /**
       * The run that ended: the followed one, or the running turn a queued
       * message was promoted into, which carries on its work.
       */
      readonly runId: RunId;
      /** When it ended, where the step could read it. */
      readonly end?: string | null;
    }
  | {
      readonly _tag: "Running";
      readonly questions: ReadonlyArray<{ readonly id: string; readonly kind: string | null }>;
      /** The run that asks them: a continuation or joined run of the followed one, else it. */
      readonly askedRunId?: RunId;
      readonly escalatesUserInput?: boolean;
      readonly retryIfNoNewQuestions?: boolean;
    }
  | { readonly _tag: "RunMissing" }
  | { readonly _tag: "Gone"; readonly reason: string }
  | { readonly _tag: "LauncherGone" }
  | { readonly _tag: "CallerChanged" }
  | { readonly _tag: "Unreachable"; readonly error: string };
