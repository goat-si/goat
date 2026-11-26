import type { EnvironmentProject, EnvironmentThreadShell } from "./models.ts";

interface ProjectRemovalMessages {
  readonly question: (kind: "checkout" | "project", name: string, count: number | null) => string;
  readonly path: (path: string) => string;
  readonly environment: (environment: string) => string;
  readonly group: (count: number) => string;
  readonly threads: string;
  readonly archived: string;
  readonly files: string;
  readonly otherEntries: string;
  readonly irreversible: string;
}

const english: ProjectRemovalMessages = {
  question: (kind, name, count) =>
    count === null
      ? `Remove ${kind} "${name}" and delete its threads?`
      : count > 0
        ? `Remove ${kind} "${name}" and delete its ${count} thread${count === 1 ? "" : "s"}?`
        : `Remove ${kind} "${name}"?`,
  path: (path) => `Path: ${path}`,
  environment: (environment) => `Environment: ${environment}`,
  group: (count) => `This removes ${count} grouped project entries.`,
  threads:
    "Those threads and any archived threads are deleted from GOAT. Provider sessions are kept.",
  archived: "Any archived threads are deleted from GOAT. Provider sessions are kept.",
  files: "This removes only the project entries, not the files on disk.",
  otherEntries: "Other entries in this grouped project are unaffected.",
  irreversible: "This action cannot be undone.",
};

export function planProjectRemoval<
  Thread extends Pick<
    EnvironmentThreadShell,
    "environmentId" | "projectId" | "lineage" | "sideChatOf"
  >,
>(options: {
  readonly members: ReadonlyArray<
    Pick<EnvironmentProject, "id" | "environmentId" | "title" | "workspaceRoot"> & {
      readonly environmentLabel?: string | null;
    }
  >;
  readonly groupMemberCount: number;
  readonly hasOtherMembers: boolean;
  readonly displayName: string;
  readonly threads: ReadonlyArray<Thread>;
  /** The members' threads this client does not hold: older settled threads its shell left out. */
  readonly unloadedThreadCount?: number | null;
  readonly messages?: ProjectRemovalMessages;
}) {
  const { members, groupMemberCount, hasOtherMembers, displayName, threads } = options;
  const memberKeys = new Set(members.map((member) => `${member.environmentId}:${member.id}`));
  const projectThreads = threads.filter((thread) =>
    memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
  );
  const loadedThreadCount = projectThreads.filter(
    (thread) => thread.lineage.relationshipToParent !== "subagent" && thread.sideChatOf == null,
  ).length;
  const threadCount =
    options.unloadedThreadCount === null
      ? null
      : loadedThreadCount + (options.unloadedThreadCount ?? 0);
  const isWholeGroup = members.length === groupMemberCount;
  const targetKind = hasOtherMembers || !isWholeGroup ? "checkout" : "project";
  const singleMember = members.length === 1 ? members[0]! : null;
  const targetLabel = singleMember?.title ?? displayName;
  const messages = options.messages ?? english;
  const confirmationMessage = [
    messages.question(targetKind, targetLabel, threadCount),
    ...(singleMember
      ? [
          messages.path(singleMember.workspaceRoot),
          ...(singleMember.environmentLabel
            ? [messages.environment(singleMember.environmentLabel)]
            : []),
        ]
      : [messages.group(members.length)]),
    threadCount === null || threadCount > 0 ? messages.threads : messages.archived,
    isWholeGroup && !hasOtherMembers ? messages.files : messages.otherEntries,
    messages.irreversible,
  ].join("\n");

  return { projectThreads, isWholeGroup, targetKind, confirmationMessage };
}
