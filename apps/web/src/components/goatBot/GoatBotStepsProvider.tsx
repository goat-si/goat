import { useAtomValue } from "@effect/atom-react";
import {
  createGoatBotActivityStepsAtoms,
  EMPTY_GOAT_BOT_SOURCE_STEPS,
  goatBotActivityPlacement,
  goatBotActivitySources,
  type GoatBotRow,
} from "@goat/client-runtime/goatBot";
import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  ScopedThreadRef,
} from "@goat/contracts";
import { Atom } from "effect/reactivity";
import type { ReactNode } from "react";

import { environmentThreadDetails } from "~/state/threads";
import { GoatBotStepsContext } from "./GoatBotStepsLine";

const activitySteps = createGoatBotActivityStepsAtoms(environmentThreadDetails);
const NO_STEPS = Atom.make(EMPTY_GOAT_BOT_SOURCE_STEPS).pipe(
  Atom.withLabel("goat-bot-activity-steps:none"),
);

function useSourceSteps(ref: ScopedThreadRef | undefined) {
  return useAtomValue(ref === undefined ? NO_STEPS : activitySteps.stepsAtom(ref));
}

/**
 * Places the steps of the threads a chat's work ran on among its rows. Reading a thread's steps
 * keeps that thread loaded, so wrap only a chat that is on screen.
 */
export function GoatBotStepsProvider({
  visibleTurnItems,
  rows,
  environmentId,
  taskId = null,
  children,
}: {
  readonly visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly rows: ReadonlyArray<GoatBotRow>;
  /** The bot conversation's environment; null reads nothing. */
  readonly environmentId: EnvironmentId | null;
  /** The task whose own view this is; null for the main chat. */
  readonly taskId?: string | null;
  readonly children: ReactNode;
}) {
  const sources = goatBotActivitySources({
    visibleTurnItems,
    botEnvironmentId: environmentId,
    taskId,
  });
  const local = sources.find((source) => source.kind === "local");
  const refs = local?.kind === "local" ? local.refs : [];
  // A source holds one thread: the main chat's newest session or a task's worker.
  const steps = useSourceSteps(refs[0]);
  const placement = goatBotActivityPlacement({
    rows,
    sources,
    steps: refs.length === 0 ? [] : [steps],
  });
  return <GoatBotStepsContext value={placement}>{children}</GoatBotStepsContext>;
}
