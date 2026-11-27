import type {
  ProviderApprovalDecision,
  ProviderRequestKind,
  ProviderUserInputAnswers,
} from "@goat/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";

// The prompt states the operation being approved; Codex's `reason` goes to the item's `reason`.
function codexFileChangeApprovalPrompt(input: {
  readonly grantRoot?: string | null;
  readonly fileChanges?: Readonly<
    Record<string, CodexSchema.V2ItemStartedNotification__PatchChangeKind>
  >;
}): string | undefined {
  const entries = Object.entries(input.fileChanges ?? {}).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  // The card scrolls, so every path is listed.
  const described = entries.map(([path, change]) => {
    const movePath = change.type === "update" ? change.move_path : undefined;
    return movePath ? `${change.type} ${path} -> ${movePath}` : `${change.type} ${path}`;
  });
  const grantRoot = input.grantRoot?.trim();
  return [...described, ...(grantRoot ? [`write ${grantRoot}`] : [])].join("\n") || undefined;
}

function codexCommandApprovalPrompt(
  input: Pick<
    CodexSchema.CommandExecutionRequestApprovalParams,
    "command" | "cwd" | "networkApprovalContext"
  >,
): string | undefined {
  const network = input.networkApprovalContext;
  return (
    [
      ...(input.command?.trim() ? [input.command] : []),
      ...(input.cwd?.trim() ? [`cwd ${input.cwd}`] : []),
      ...(network ? [`network ${network.protocol} ${network.host}`] : []),
    ].join("\n") || undefined
  );
}

function codexFileSystemPathLabel(
  path: CodexSchema.PermissionsRequestApprovalParams__FileSystemPath,
): string {
  if (path.type === "path") return path.path;
  if (path.type === "glob_pattern") return path.pattern;
  const special = path.value;
  switch (special.kind) {
    case "root":
      return "/ (entire filesystem)";
    case "slash_tmp":
      return "/tmp";
    case "tmpdir":
      return "temporary directory";
    case "minimal":
      return "minimal system paths";
    case "project_roots":
      return ["project roots", special.subpath].filter(Boolean).join("/");
    case "unknown":
      return [special.path, special.subpath].filter(Boolean).join("/") || "unknown path";
  }
}

function codexPermissionsApprovalPrompt(
  permissions: CodexSchema.PermissionsRequestApprovalParams["permissions"],
): string | undefined {
  // Codex may list a path both in the legacy `read`/`write` lists and in `entries`.
  const lines = new Set<string>();
  for (const access of ["read", "write"] as const) {
    for (const path of permissions.fileSystem?.[access] ?? []) lines.add(`${access} ${path}`);
  }
  for (const entry of permissions.fileSystem?.entries ?? []) {
    lines.add(`${entry.access} ${codexFileSystemPathLabel(entry.path)}`);
  }
  if (permissions.network?.enabled) lines.add("network");
  return [...lines].join("\n") || undefined;
}

function approvalDecisionToLegacyReviewDecision(
  decision: ProviderApprovalDecision,
): CodexSchema.ExecCommandApprovalResponse__ReviewDecision {
  switch (decision) {
    case "accept":
      return "approved";
    case "acceptForSession":
    case "acceptAlways":
      return "approved_for_session";
    case "decline":
      return { denied: { rejection: "User declined the request." } };
    case "cancel":
      return "abort";
  }
}

function providerRequestKindFromPermissions(
  permissions: CodexSchema.PermissionsRequestApprovalParams["permissions"],
): ProviderRequestKind {
  // Codex leaves the legacy `read`/`write` lists out when a path is a glob or
  // special path, and is replacing them with `entries`.
  const requests = (access: "read" | "write") =>
    (permissions.fileSystem?.[access]?.length ?? 0) > 0 ||
    permissions.fileSystem?.entries?.some((entry) => entry.access === access);
  if (requests("write")) {
    return "file-change";
  }
  if (requests("read")) {
    return "file-read";
  }
  return "command";
}

function permissionsResponseFromDecision(input: {
  readonly decision: ProviderApprovalDecision;
  readonly permissions: CodexSchema.PermissionsRequestApprovalParams["permissions"];
}): CodexSchema.PermissionsRequestApprovalResponse {
  if (input.decision !== "accept" && input.decision !== "acceptForSession") {
    return { permissions: {}, scope: "turn" };
  }

  return {
    permissions: input.permissions,
    scope: input.decision === "acceptForSession" ? "session" : "turn",
  };
}

function answerValueToStrings(value: unknown): ReadonlyArray<string> {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value === "string") {
    return [value];
  }
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  return [JSON.stringify(value)];
}

function toCodexUserInputAnswers(
  answers: ProviderUserInputAnswers,
  nativeQuestionIds: ReadonlyMap<string, string>,
): CodexSchema.ToolRequestUserInputResponse["answers"] {
  return Object.fromEntries(
    Object.entries(answers).flatMap(([questionId, value]) => {
      const nativeId = nativeQuestionIds.get(questionId);
      return nativeId === undefined
        ? []
        : [[nativeId, { answers: [...answerValueToStrings(value)] }]];
    }),
  );
}

export {
  approvalDecisionToLegacyReviewDecision,
  codexCommandApprovalPrompt,
  codexFileChangeApprovalPrompt,
  codexPermissionsApprovalPrompt,
  permissionsResponseFromDecision,
  providerRequestKindFromPermissions,
  toCodexUserInputAnswers,
};
