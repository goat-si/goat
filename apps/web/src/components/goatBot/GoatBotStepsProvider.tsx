import { useAtomValue } from "@effect/atom-react";
import {
  createGoatBotActivityStepsAtoms,
  EMPTY_GOAT_BOT_SOURCE_STEPS,
  goatBotActivityPlacement,
  goatBotActivityRowTurns,
  goatBotActivitySources,
  type GoatBotActivitySource,
  type GoatBotRow,
} from "@goat/client-runtime/goatBot";
import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  ScopedThreadRef,
} from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { createContext, useContext, type ReactNode } from "react";

import { useServerConfigs } from "~/state/entities";
import { environmentThreadDetails } from "~/state/threads";
import { GoatBotStepsContext } from "./GoatBotStepsLine";

const activitySteps = createGoatBotActivityStepsAtoms(environmentThreadDetails);
const NO_STEPS = Atom.make(EMPTY_GOAT_BOT_SOURCE_STEPS).pipe(
  Atom.withLabel("goat-bot-activity-steps:none"),
);

function useSourceSteps(ref: ScopedThreadRef | undefined) {
  return useAtomValue(ref === undefined ? NO_STEPS : activitySteps.stepsAtom(ref));
}

interface GoatBotStepsSources {
  readonly sources: ReadonlyArray<GoatBotActivitySource>;
  readonly rowTurns: ReadonlyMap<string, string>;
}

const GoatBotStepsSourcesContext = createContext<GoatBotStepsSources | null>(null);

/** Says which threads hold the steps of a chat's work; `GoatBotStepsReader` below it reads them. */
export function GoatBotStepsProvider({
  visibleTurnItems,
  environmentId,
  taskId = null,
  children,
}: {
  readonly visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  /** The bot conversation's environment; null reads nothing. */
  readonly environmentId: EnvironmentId | null;
  /** The task whose own view this is; null for the main chat. */
  readonly taskId?: string | null;
  readonly children: ReactNode;
}) {
  const configs = useServerConfigs();
  // Every server that lists open asks also sends a thread's newest part only.
  const boundedSnapshots =
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.goatBotOpenAsks === true;
  const value: GoatBotStepsSources = {
    sources: goatBotActivitySources({
      visibleTurnItems,
      botEnvironmentId: environmentId,
      taskId,
      boundedSnapshots,
    }),
    rowTurns: goatBotActivityRowTurns(visibleTurnItems),
  };
  return <GoatBotStepsSourcesContext value={value}>{children}</GoatBotStepsSourcesContext>;
}

/**
 * Places the steps among the rows. Reading a thread's steps keeps it loaded, so this goes only
 * around a conversation on screen, and `paused` lets go of it while something covers it.
 */
export function GoatBotStepsReader({
  rows,
  paused = false,
  children,
}: {
  readonly rows: ReadonlyArray<GoatBotRow>;
  readonly paused?: boolean;
  readonly children: ReactNode;
}) {
  const read = useContext(GoatBotStepsSourcesContext);
  const local = read?.sources.find((source) => source.kind === "local");
  const refs = local?.kind === "local" ? local.refs : [];
  // A source holds one thread: the main chat's newest session or a task's worker.
  const steps = useSourceSteps(paused ? undefined : refs[0]);
  const placement =
    read === null || paused
      ? null
      : goatBotActivityPlacement({
          rows,
          sources: read.sources,
          steps: refs.length === 0 ? [] : [steps],
          rowTurns: read.rowTurns,
        });
  return <GoatBotStepsContext value={placement}>{children}</GoatBotStepsContext>;
}
