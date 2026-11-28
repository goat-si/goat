// GOAT 2 runtime stamp: what a single run actually ran on, captured once at run start.
// New in GOAT 2 (goat origin/dev keeps only the provider's *current* version in ServerProvider,
// so old runs show the wrong CLI version after an update). See docs/PRD.md and
// goat_initiative PR #10 (docs/070_goat_bot_gui.md "실행 도장").
import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  IsoDateTime,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
} from "@goat2/contracts";

export const RuntimeStamp = Schema.Struct({
  /** CLI family: codex, claudeAgent, antigravity, pi, opencode, ... */
  driver: ProviderDriverKind,
  /** Which install/account instance of that driver. */
  instanceId: ProviderInstanceId,
  /** Human label for the CLI, from ServerProvider.displayName. */
  displayName: Schema.NullOr(TrimmedNonEmptyString),
  /** CLI version at run start. Null = could not be determined (show "version unknown"). */
  cliVersion: Schema.NullOr(TrimmedNonEmptyString),
  /** Model plus options (reasoning effort, service tier, ...). */
  modelSelection: ModelSelection,
  environmentId: EnvironmentId,
  /** Display name of the machine at stamp time. */
  machineLabel: Schema.NullOr(TrimmedNonEmptyString),
  executionLocation: Schema.Literals(["local", "cloud"]),
  /** Account kind + masked email, e.g. "ChatGPT Pro · j***@lidgeai.com". Never a secret. */
  authLabel: Schema.NullOr(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  workspace: Schema.NullOr(
    Schema.Struct({
      repo: Schema.NullOr(TrimmedNonEmptyString),
      branch: Schema.NullOr(TrimmedNonEmptyString),
      worktreePath: Schema.NullOr(TrimmedNonEmptyString),
    }),
  ),
  /** Thread the run belongs to; the transcript itself stays in the CLI's own session log. */
  threadId: ThreadId,
  /** Pointer to the CLI's native session log (read on demand, never copied into our DB). */
  nativeSessionRef: Schema.NullOr(TrimmedNonEmptyString),
  stampedAt: IsoDateTime,
});
export type RuntimeStamp = typeof RuntimeStamp.Type;

/** Short form for chips and folded rows: "Codex CLI 0.142 · gpt-6.1-sol". */
export function formatRuntimeShort(stamp: Pick<RuntimeStamp, "displayName" | "driver" | "cliVersion" | "modelSelection">): string {
  const name = stamp.displayName ?? stamp.driver;
  const version = stamp.cliVersion ? ` ${stamp.cliVersion}` : "";
  return `${name}${version} · ${stamp.modelSelection.model}`;
}
