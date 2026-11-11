import { useAtomValue } from "@effect/atom-react";
import {
  createGoatBotActivityStepsAtoms,
  EMPTY_GOAT_BOT_SOURCE_STEPS,
  goatBotActivityPlacement,
  goatBotActivityRowTurns,
  goatBotActivitySources,
  type GoatBotActivityMark,
  type GoatBotActivityPlacement,
  type GoatBotRow,
} from "@goat/client-runtime/goatBot";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { useCallback, useMemo, useState } from "react";

import { environmentThreadDetails } from "../../state/threads";

// Made on first read, so screens and tests that never read steps never touch the thread state.
let activitySteps: ReturnType<typeof createGoatBotActivityStepsAtoms> | null = null;
const stepsAtoms = () =>
  (activitySteps ??= createGoatBotActivityStepsAtoms(environmentThreadDetails));
const NO_STEPS = Atom.make(EMPTY_GOAT_BOT_SOURCE_STEPS).pipe(
  Atom.withLabel("goat-bot-activity-steps:none"),
);
const NO_MARKS: GoatBotActivityPlacement = { beforeRow: new Map(), trailing: null };
/** Opened lines kept per conversation; older ones close. */
const MAX_OPENED = 50;
const NO_OPENED: ReadonlySet<string> = new Set();

function sameMark(a: GoatBotActivityMark | null, b: GoatBotActivityMark | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "elsewhere" || b.kind === "elsewhere")
    return (
      a.kind === b.kind && a.kind === "elsewhere" && b.kind === "elsewhere" && a.host === b.host
    );
  const x = a.line;
  const y = b.line;
  return (
    x.key === y.key &&
    x.summary === y.summary &&
    x.live === y.live &&
    x.failedCount === y.failedCount &&
    x.earlier === y.earlier &&
    x.steps.length === y.steps.length &&
    x.steps.every((step, index) => step === y.steps[index])
  );
}

function samePlacement(a: GoatBotActivityPlacement, b: GoatBotActivityPlacement): boolean {
  if (a.beforeRow.size !== b.beforeRow.size || !sameMark(a.trailing, b.trailing)) return false;
  for (const [rowId, mark] of a.beforeRow)
    if (!sameMark(mark, b.beforeRow.get(rowId) ?? null)) return false;
  return true;
}

/**
 * GOAT Bot's activity lines for the rows a chat draws, and which of them are open. The steps come
 * from the newest session (or a task's worker) and are read only while `reading`, so a hidden or
 * covered chat lets go of that thread. The placement keeps its identity while no line changes.
 */
export function useGoatBotActivityMarks(input: {
  readonly visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly environmentId: EnvironmentId | null;
  readonly taskId: string | null;
  readonly boundedSnapshots: boolean;
  /** The rows the list draws, without the unread divider. */
  readonly rows: ReadonlyArray<GoatBotRow>;
  readonly reading: boolean;
  /** The conversation the open lines belong to. */
  readonly scope: string;
}) {
  const { visibleTurnItems, environmentId, taskId, boundedSnapshots, rows, reading } = input;
  const sources = useMemo(
    () =>
      goatBotActivitySources({
        visibleTurnItems,
        botEnvironmentId: environmentId,
        taskId,
        boundedSnapshots,
      }),
    [visibleTurnItems, environmentId, taskId, boundedSnapshots],
  );
  const rowTurns = useMemo(() => goatBotActivityRowTurns(visibleTurnItems), [visibleTurnItems]);
  const local = sources.find((source) => source.kind === "local");
  // A source holds one thread: the main chat's newest session or a task's worker.
  const ref = reading && local?.kind === "local" ? local.refs[0] : undefined;
  const steps = useAtomValue(ref === undefined ? NO_STEPS : stepsAtoms().stepsAtom(ref));
  const next = useMemo(
    () =>
      reading
        ? goatBotActivityPlacement({
            rows,
            sources,
            steps: ref === undefined ? [] : [steps],
            rowTurns,
          })
        : NO_MARKS,
    [reading, rows, sources, ref, steps, rowTurns],
  );
  const [kept, setKept] = useState(next);
  const changed = !samePlacement(kept, next);
  if (changed) setKept(next);
  const placement = changed ? next : kept;

  const [opened, setOpened] = useState<{
    readonly scope: string;
    readonly keys: readonly string[];
  }>({ scope: input.scope, keys: [] });
  const openKeys = opened.scope === input.scope ? opened.keys : null;
  const openSet = useMemo(() => (openKeys === null ? NO_OPENED : new Set(openKeys)), [openKeys]);
  const scope = input.scope;
  const toggle = useCallback(
    (key: string) =>
      setOpened((current) => {
        const keys = current.scope === scope ? current.keys : [];
        return {
          scope,
          keys: keys.includes(key)
            ? keys.filter((each) => each !== key)
            : [...keys, key].slice(-MAX_OPENED),
        };
      }),
    [scope],
  );
  return { placement, opened: openSet, toggle };
}
