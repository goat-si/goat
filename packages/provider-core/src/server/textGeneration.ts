import type {
  ResolveMemoryConflictInput,
  ResolveMemoryConflictExecutionResult,
  GenerateMemorySummaryInput,
  GenerateMemorySummaryExecutionResult,
  BranchNamingOptions,
  ChannelReceptionInput,
  ChannelReceptionResult,
  ChatAttachment,
  ModelSelection,
  PullRequestReviewGuide,
  TextGenerationError,
} from "@goat/contracts";
import type * as Effect from "effect/Effect";

import type { TextGenerationPolicy } from "./textGenerationPolicy.ts";
import type { ThreadTitleForkSource } from "./textGenerationPrompts.ts";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  changeRequestTemplate?: string | undefined;
  threadContext?: string | undefined;
  policy?: TextGenerationPolicy | undefined;
  modelSelection: ModelSelection;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  naming?: BranchNamingOptions | undefined;
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  linkedContext?: string | undefined;
  cwd: string;
  message: string;
  previousTitle?: string | undefined;
  forkSource?: ThreadTitleForkSource | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  instructions?: string | undefined;
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
  needsRefinement?: boolean | undefined;
}

export interface ChannelReceptionGenerationInput {
  /** An empty scratch directory: reception reads no checkout rules or files. */
  cwd: string;
  input: ChannelReceptionInput;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ReviewGuideStackLayer {
  readonly number: number;
  readonly title: string | null;
  readonly headSha: string | null;
  readonly state: "open" | "closed" | "merged";
}

export interface ReviewGuideGenerationInput {
  cwd: string;
  number: number;
  title: string;
  description: string;
  baseBranch: string;
  baseCommit: string;
  settledReview: string;
  instructions?: string | undefined;
  stack?: ReadonlyArray<ReviewGuideStackLayer> | undefined;
  modelSelection: ModelSelection;
}

export type ReviewGuideGenerationResult = Omit<
  PullRequestReviewGuide,
  "headSha" | "generatedAt" | "modelSelection"
>;

/** Commit, change request, branch, title, review guide, and channel reception generation backed by one provider instance. */
export interface ProviderTextGeneration {
  readonly resolveMemoryConflict?: (
    input: ResolveMemoryConflictInput,
  ) => Effect.Effect<ResolveMemoryConflictExecutionResult, TextGenerationError>;
  readonly generateMemorySummary?: (
    input: GenerateMemorySummaryInput,
  ) => Effect.Effect<GenerateMemorySummaryExecutionResult, TextGenerationError>;
  /**
   * Generate a commit message from staged change context.
   */
  readonly generateCommitMessage: (
    input: CommitMessageGenerationInput,
  ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

  readonly generatePrContent: (
    input: PrContentGenerationInput,
  ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

  readonly generateBranchName: (
    input: BranchNameGenerationInput,
  ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

  /**
   * Answer one channel message or task event with a short reply and a structured action, with
   * tools disabled. Providers without it cannot serve as the channel reception model.
   */
  readonly generateChannelReception?: (
    input: ChannelReceptionGenerationInput,
  ) => Effect.Effect<ChannelReceptionResult, TextGenerationError>;

  /** Explain a change request to the maintainer deciding whether it lands. */
  readonly generateReviewGuide: (
    input: ReviewGuideGenerationInput,
  ) => Effect.Effect<ReviewGuideGenerationResult, TextGenerationError>;
}

export type {
  ResolveMemoryConflictInput,
  ResolveMemoryConflictResult,
  ResolveMemoryConflictExecutionResult,
  GenerateMemorySummaryInput,
  GenerateMemorySummaryResult,
  GenerateMemorySummaryExecutionResult,
  MemoryGenerationExecution,
} from "@goat/contracts";
