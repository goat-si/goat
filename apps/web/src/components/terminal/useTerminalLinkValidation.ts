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
  const [hoveredLink, setHoveredLink] = useState<{ text: string; fallback?: string } | null>(null);
  const metadataThreadRef = useContext(FileMetadataThreadContext);
  const hoveredMetadataQuery = (text: string | undefined) =>
    text !== undefined && canOpenHostEditor && canReadFilesystem
      ? getFileMetadataQueryAtom(
          environmentId,
          resolveTerminalLinkTarget(text, cwd),
          cwd,
          metadataThreadRef,
        )
      : null;
  const linkMetadataQuery = hoveredMetadataQuery(hoveredLink?.text);
  const fallbackMetadataQuery = hoveredMetadataQuery(hoveredLink?.fallback);
  const canActivateTerminalLink = useEffectEvent((text: string) => {
    if (isTerminalUrl(text)) return true;
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      !readEnvironmentScope(environmentId, AuthFilesystemReadScope)
    )
      return false;
    const exists = (query: typeof linkMetadataQuery) => {
      const metadata = query ? AsyncResult.getOrElse(appAtomRegistry.get(query), () => null) : null;
      return metadata?.kind === "file" || metadata?.kind === "directory";
    };
    if (text === hoveredLink?.text) return exists(linkMetadataQuery);
    // The shorter reading stands in only once the whole candidate is known to be no file.
    return (
      text === hoveredLink?.fallback &&
      (!linkMetadataQuery || AsyncResult.isSuccess(appAtomRegistry.get(linkMetadataQuery))) &&
      !exists(linkMetadataQuery) &&
      exists(fallbackMetadataQuery)
    );
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
    const refresh = () => terminalRef.current?.refreshLinkActivation();
    const unsubscribes = [linkMetadataQuery, fallbackMetadataQuery].flatMap((query) =>
      query ? [appAtomRegistry.subscribe(query, refresh, { immediate: true })] : [],
    );
    if (unsubscribes.length === 0) refresh();
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [linkMetadataQuery, fallbackMetadataQuery, terminalRef]);

  return { canActivateTerminalLink, validateTerminalLink, setHoveredLink };
}
