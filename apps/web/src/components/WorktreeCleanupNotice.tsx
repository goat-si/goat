import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@goat/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, type RefObject } from "react";
import { useEnvironment, useEnvironmentIdentities } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { toastManager } from "./ui/toast";

export function WorktreeCleanupNotice() {
  const identities = useEnvironmentIdentities();
  const seen = useRef(new Set<string>());
  return identities.map(({ environmentId }) => (
    <EnvironmentNotice key={environmentId} environmentId={environmentId} seen={seen} />
  ));
}

function EnvironmentNotice({
  environmentId,
  seen,
}: {
  environmentId: EnvironmentId;
  seen: RefObject<Set<string>>;
}) {
  const environment = useEnvironment(environmentId);
  if (
    environment?.connection.phase !== "connected" ||
    environment.serverConfig?.environment.capabilities.worktreeRestore !== true
  )
    return null;
  return <PreviewNotice environmentId={environmentId} seen={seen} />;
}

function PreviewNotice({
  environmentId,
  seen,
}: {
  environmentId: EnvironmentId;
  seen: RefObject<Set<string>>;
}) {
  const report = useAtomValue(serverEnvironment.storageCleanupReport({ environmentId, input: {} }));
  const allowed = useAtomValue(
    serverEnvironment.respondWorktreeCleanupPreview.permissionAtom(environmentId),
  );
  const respond = useAtomCommand(serverEnvironment.respondWorktreeCleanupPreview);
  const navigate = useNavigate();
  const preview = report._tag === "Success" ? report.value?.worktreePreview : undefined;
  // oxlint-disable-next-line goat/react-effect-budget -- Announce newly received previews once per session.
  useEffect(() => {
    if (!allowed || !preview || preview.seenAt !== null) return;
    const key = `${environmentId}:${preview.id}`;
    if (seen.current.has(key)) return;
    seen.current.add(key);
    toastManager.add({
      title: `GOAT will clean up ${preview.plannedCount === 1 ? "1 worktree" : `${preview.plannedCount} worktrees`}`,
      actionProps: {
        children: "Review",
        onClick: () =>
          void navigate({
            to: "/settings/storage",
            search: { machine: environmentId },
            hash: "storage-cleanup",
          }),
      },
    });
    void respond({ environmentId, input: { previewId: preview.id, response: "seen" } });
  }, [allowed, preview, environmentId, seen, respond, navigate]);
  return null;
}
