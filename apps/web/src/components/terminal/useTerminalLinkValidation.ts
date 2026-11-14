import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  type EnvironmentId,
} from "@goat/contracts";
import { executeAtomQuery } from "@goat/client-runtime/state/runtime";
import { resolveTerminalLinkTarget } from "../../terminal-links";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useEffectEvent, useState, type RefObject } from "react";
import { FileMetadataThreadContext } from "../../hooks/FileMetadataThreadProvider";
import { getFileMetadataQueryAtom } from "../../hooks/useFileMetadata";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { isTerminalUrl } from "../../terminal-links";
import type { GhosttyTerminalSurface } from "../../terminal/ghostty/surface";

export function useTerminalLinkValidation(
  environmentId: EnvironmentId,
  cwd: string,
  terminalRef: RefObject<GhosttyTerminalSurface | null>,
) {
  const canOpenHostEditor = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canReadFilesystem = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const [linkPath, setLinkPath] = useState<string | null>(null);
  const metadataThreadRef = useContext(FileMetadataThreadContext);
  const linkMetadataQuery =
    linkPath !== null && canOpenHostEditor && canReadFilesystem
      ? getFileMetadataQueryAtom(
          environmentId,
          resolveTerminalLinkTarget(linkPath, cwd),
          cwd,
          metadataThreadRef,
        )
      : null;
  const canActivateTerminalLink = useEffectEvent((text: string) => {
    if (isTerminalUrl(text)) return true;
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      !readEnvironmentScope(environmentId, AuthFilesystemReadScope)
    )
      return false;
    if (text !== linkPath || !linkMetadataQuery) return false;
    const metadata = AsyncResult.getOrElse(appAtomRegistry.get(linkMetadataQuery), () => null);
    return metadata?.kind === "file" || metadata?.kind === "directory";
  });
  const validateTerminalLink = useEffectEvent(async (text: string) => {
    if (isTerminalUrl(text)) return true;
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      !readEnvironmentScope(environmentId, AuthFilesystemReadScope)
    )
      return false;
    const query = getFileMetadataQueryAtom(
      environmentId,
      resolveTerminalLinkTarget(text, cwd),
      cwd,
      metadataThreadRef,
    );
    if (!query) return false;
    const result = await executeAtomQuery(appAtomRegistry, query, { reportFailure: false });
    return (
      result._tag === "Success" &&
      (result.value?.kind === "file" || result.value?.kind === "directory")
    );
  });
  // oxlint-disable-next-line goat/react-effect-budget -- syncs hovered terminal link after metadata changes
  useEffect(() => {
    if (!linkMetadataQuery) {
      terminalRef.current?.refreshLinkActivation();
      return;
    }
    return appAtomRegistry.subscribe(
      linkMetadataQuery,
      () => terminalRef.current?.refreshLinkActivation(),
      { immediate: true },
    );
  }, [linkMetadataQuery, terminalRef]);

  return { canActivateTerminalLink, validateTerminalLink, setLinkPath };
}
