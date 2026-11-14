import { CloudDownloadIcon, CloudUploadIcon, GitCommitIcon, InfoIcon } from "~/components/solar";
import type { GitActionIconName, GitQuickAction } from "./GitActionsControl.logic";
import type { getSourceControlPresentation } from "../sourceControlPresentation";

export function GitActionItemIcon({
  icon,
  SourceControlIcon,
}: {
  icon: GitActionIconName;
  SourceControlIcon: ReturnType<typeof getSourceControlPresentation>["Icon"];
}) {
  if (icon === "commit") return <GitCommitIcon />;
  if (icon === "push") return <CloudUploadIcon />;
  return <SourceControlIcon />;
}

export function GitQuickActionIcon({
  quickAction,
  SourceControlIcon,
  className = "size-3.5",
}: {
  quickAction: GitQuickAction;
  className?: string;
  SourceControlIcon: ReturnType<typeof getSourceControlPresentation>["Icon"];
}) {
  if (quickAction.kind === "open_publish") return <CloudUploadIcon className={className} />;
  if (quickAction.kind === "run_pull") return <CloudDownloadIcon className={className} />;
  if (quickAction.kind === "run_action") {
    if (quickAction.action === "commit") return <GitCommitIcon className={className} />;
    if (quickAction.action === "push" || quickAction.action === "commit_push") {
      return <CloudUploadIcon className={className} />;
    }
    return <SourceControlIcon className={className} />;
  }
  if (quickAction.label === "Commit") return <GitCommitIcon className={className} />;
  if (quickAction.label === "Push") return <CloudUploadIcon className={className} />;
  return <InfoIcon className={className} />;
}
