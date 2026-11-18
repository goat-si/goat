import type {
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
} from "@goat/contracts";

export interface StartThreadBootstrap {
  readonly createThread?: {
    readonly projectId: ProjectId;
    readonly title: string;
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly createdAt: string;
  };
  readonly prepareWorktree?: {
    readonly requireWorktree?: boolean;
    readonly projectCwd: string;
    readonly baseBranch: string;
    readonly branch?: string;
    readonly startFromOrigin?: boolean;
  };
  readonly runSetupScript?: boolean;
}
