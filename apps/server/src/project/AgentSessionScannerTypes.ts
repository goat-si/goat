import type {
  AgentSessionImportSource,
  AgentSessionProjectCandidate,
  ProviderInstanceId,
} from "@goat/contracts";

export type AgentSessionSource = AgentSessionProjectCandidate["sources"][number];

export interface AgentSessionThreadMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface AgentSessionThread {
  readonly source: AgentSessionSource;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: string;
  readonly title: string;
  readonly model: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: ReadonlyArray<AgentSessionThreadMessage>;
  readonly omittedMessageCount: number;
}

export type AgentSessionRecentThread =
  | {
      readonly _tag: "Importable";
      readonly thread: AgentSessionThread;
      readonly source: AgentSessionImportSource;
      /** The root's linked worktree the session ran in, or null when it ran in the root. */
      readonly worktree: { readonly path: string; readonly branch: string | null } | null;
    }
  | { readonly _tag: "AlreadyImported"; readonly source: AgentSessionImportSource }
  | {
      readonly _tag: "Duplicate";
      readonly source: AgentSessionImportSource;
      readonly messages: AgentSessionThread["messages"];
    }
  | { readonly _tag: "Skipped"; readonly thread: string; readonly reason: string };
