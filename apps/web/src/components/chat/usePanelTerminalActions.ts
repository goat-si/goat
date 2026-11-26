import { AuthTerminalOperateScope, type ScopedThreadRef } from "@goat/contracts";
import { getTerminalLabel } from "@goat/shared/terminalLabels";
import { useStableCallback } from "../../hooks/useStableCallback";
import { confirmTerminalClose } from "../../lib/terminalCloseConfirm";
import { focusActivePanelTerminal, focusTerminal } from "../../lib/terminalFocus";
import {
  selectThreadRightPanelState,
  type RightPanelSurface,
  useRightPanelStore,
} from "../../rightPanelStore";
import { readEnvironmentScope } from "../../state/session";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import { MAX_TERMINALS_PER_GROUP } from "../../types";
import type { useThreadTerminalActions } from "../terminal/useThreadTerminalActions";

/** The right panel's terminal tabs: open, split, switch and close them. */
export function usePanelTerminalActions(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly activeSurface: RightPanelSurface | null;
  readonly terminalLabelsById: ReadonlyMap<string, string>;
  readonly terminalActions: ReturnType<typeof useThreadTerminalActions>;
}) {
  const { threadRef, activeSurface, terminalLabelsById, terminalActions } = input;
  const storeCloseTerminal = useTerminalUiStateStore((s) => s.closeTerminal);
  const canOperate = (target: ScopedThreadRef | null): target is ScopedThreadRef =>
    target !== null && readEnvironmentScope(target.environmentId, AuthTerminalOperateScope);

  const addTerminalSurface = () => {
    if (!threadRef) return;
    const launched = terminalActions.launchTerminal({
      place: (terminalId) => useRightPanelStore.getState().openTerminal(threadRef, terminalId),
    });
    if (!launched) return;
    focusTerminal(threadRef, launched.terminalId);
    void launched.result;
  };
  const splitPanelTerminal = (direction: "horizontal" | "vertical" = "horizontal") => {
    if (
      !threadRef ||
      activeSurface?.kind !== "terminal" ||
      activeSurface.terminalIds.length >= MAX_TERMINALS_PER_GROUP
    ) {
      return;
    }
    const surfaceId = activeSurface.id;
    const launched = terminalActions.launchTerminal({
      place: (terminalId) =>
        useRightPanelStore.getState().splitTerminal(threadRef, surfaceId, terminalId, direction),
    });
    if (!launched) return;
    focusTerminal(threadRef, launched.terminalId);
    void launched.result;
  };
  const activatePanelTerminal = (terminalId: string) => {
    if (!threadRef || activeSurface?.kind !== "terminal") return;
    useRightPanelStore.getState().activateTerminal(threadRef, activeSurface.id, terminalId);
    focusTerminal(threadRef, terminalId);
  };
  const closePanelTerminal = (terminalId: string, target = threadRef) => {
    if (!canOperate(target)) return;
    const store = useRightPanelStore.getState();
    const surface = selectThreadRightPanelState(store.byThreadKey, target).surfaces.find(
      (entry) => entry.kind === "terminal" && entry.terminalIds.includes(terminalId),
    );
    if (!surface) return;
    terminalActions.closeTerminalSession(terminalId, target);
    storeCloseTerminal(target, terminalId);
    store.closeTerminal(target, surface.id, terminalId);
    focusActivePanelTerminal(target);
  };
  const requestClosePanelTerminal = (terminalId: string) => {
    if (!canOperate(threadRef)) return;
    const label = terminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId);
    void confirmTerminalClose([label]).then((confirmed) => {
      if (confirmed && canOperate(threadRef)) closePanelTerminal(terminalId);
    });
  };

  return {
    addTerminalSurfaceStable: useStableCallback(addTerminalSurface),
    splitPanelTerminalStable: useStableCallback(splitPanelTerminal),
    splitPanelTerminalVerticalStable: useStableCallback(() => splitPanelTerminal("vertical")),
    activatePanelTerminalStable: useStableCallback(activatePanelTerminal),
    closePanelTerminalStable: useStableCallback(closePanelTerminal),
    requestClosePanelTerminalStable: useStableCallback(requestClosePanelTerminal),
  };
}
