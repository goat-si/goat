import { useAtomValue } from "@effect/atom-react";
import { groupBotWork, type BotWorkTask } from "@goat/client-runtime/goatBot";
import { runAtomCommand, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type {
  BotId,
  BotWorkResult,
  ChannelChildWorkGroup,
  ChannelTaskId,
  EnvironmentId,
} from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";

const NO_PERMISSION = Atom.make(false);

type Unavailable = Extract<BotWorkResult["task"], { readonly state: "unavailable" }>;

/** What a task's own screen knows about a task its bot's current list does not hold. */
export type MobileTaskLookup =
  /** Not asked: no settled list yet, the list holds the task, no lookup on this server, or offline. */
  | { readonly state: "off" }
  | { readonly state: "denied" }
  | { readonly state: "loading" }
  | { readonly state: "missing" }
  | { readonly state: "failed"; readonly retry: () => void }
  | { readonly state: "known"; readonly task: BotWorkTask; readonly result: BotWorkResult }
  | { readonly state: "unavailable"; readonly task: Unavailable; readonly result: BotWorkResult };

/** Everything the one lookup decision reads, for the task the screen shows now. */
export type TaskLookupFacts = {
  /** The server looks tasks up, the computer is connected, and this device may read. */
  readonly able: boolean;
  readonly permitted: boolean;
  /** A current-list read has succeeded for this computer and bot. */
  readonly established: boolean;
  /** A current-list read is in flight. */
  readonly refreshing: boolean;
  /** The last successful current list holds the task. */
  readonly holdsTask: boolean;
  /** The saved answer is this task's; a failed read is an answer too. */
  readonly held: boolean;
  /** An action on this task completed after its last read started. */
  readonly stale: boolean;
  /** A read for this task is running. */
  readonly inFlight: boolean;
};

/**
 * What the task screen shows, and whether a read starts by itself. Nothing else starts a read
 * except Try again; so a task change during a refresh waits for it, an action's reread waits for
 * its refresh to settle (success or failure), and a refresh that returns the task reads nothing.
 * A held answer, a failure included, is read again only once an action made it stale.
 */
export function taskLookupDecision(facts: TaskLookupFacts): {
  readonly view: "off" | "row" | "denied" | "answer" | "loading";
  readonly read: boolean;
} {
  if (!facts.able || !facts.established) return { view: "off", read: false };
  if (facts.holdsTask) return { view: "row", read: false };
  if (!facts.permitted) return { view: "denied", read: false };
  const read = !facts.refreshing && !facts.inFlight && (facts.stale || !facts.held);
  return { view: facts.held ? "answer" : "loading", read };
}

/** The last answer for one task: what it read, or why it could not. */
type Saved =
  | { readonly key: string; readonly value: BotWorkResult }
  | { readonly key: string; readonly error: "missing" | "denied" | "failed" };

/** not_found, a refusal by the server's access check, or any other failure. */
function failureKind(error: unknown): "missing" | "denied" | "failed" {
  if (typeof error !== "object" || error === null) return "failed";
  if ("reason" in error && error.reason === "not_found") return "missing";
  if ("_tag" in error && error._tag === "EnvironmentAuthorizationError") return "denied";
  return "reason" in error && error.reason === "forbidden" ? "denied" : "failed";
}

const lookupKey = (
  environmentId: EnvironmentId | null,
  botId: BotId,
  taskId: ChannelTaskId | null,
) => JSON.stringify([environmentId, botId, taskId]);

/**
 * Reads one task of one bot by id on request (`channel.getBotTask`) for a task screen whose task
 * the current list does not hold, by the rule in `taskLookupDecision`. `invalidate` marks the
 * shown task stale after an action on it; a mark for a task the screen has left is dropped.
 */
export function useMobileBotTaskLookup(input: {
  readonly environmentId: EnvironmentId | null;
  readonly botId: BotId;
  readonly taskId: ChannelTaskId | null;
  /** The server advertises the lookup and the computer is connected. */
  readonly supported: boolean;
  readonly established: boolean;
  readonly refreshing: boolean;
  readonly holdsTask: boolean;
  /** Child work read for this task, for its subagents. */
  readonly childGroups: ReadonlyArray<ChannelChildWorkGroup>;
}): { readonly lookup: MobileTaskLookup; readonly invalidate: () => void } {
  const { environmentId, botId, taskId } = input;
  const able = input.supported && environmentId !== null && taskId !== null;
  const permitted = useAtomValue(
    able && environmentId !== null
      ? channelEnvironment.getBotTask.permissionAtom(environmentId)
      : NO_PERMISSION,
  );
  const key = lookupKey(environmentId, botId, taskId);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [staleKey, setStaleKey] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState<{ key: string; generation: number } | null>(null);
  // The read in flight, for the answer's check and for a second press before the screen renders.
  const running = useRef<{ key: string; generation: number } | null>(null);
  const generation = useRef(0);
  // A mark for a task the screen has left is dropped.
  if (staleKey !== null && staleKey !== key) setStaleKey(null);
  const decision = taskLookupDecision({
    able,
    permitted,
    established: input.established,
    refreshing: input.refreshing,
    holdsTask: input.holdsTask,
    held: saved?.key === key,
    stale: staleKey === key,
    inFlight: inFlight?.key === key,
  });
  const read = (environmentId: EnvironmentId, botId: BotId, taskId: ChannelTaskId) => {
    const sentKey = lookupKey(environmentId, botId, taskId);
    if (running.current?.key === sentKey) return;
    const sent = { key: sentKey, generation: ++generation.current };
    running.current = sent;
    setInFlight(sent);
    setStaleKey((current) => (current === sentKey ? null : current));
    void runAtomCommand(
      appAtomRegistry,
      channelEnvironment.getBotTask,
      { environmentId, input: { taskId, botId } },
      { label: "GOAT Bot task lookup", reportFailure: false },
    ).then((result) => {
      // Only the newest read answers; one a later read replaced lands nowhere.
      if (running.current?.generation !== sent.generation) return;
      running.current = null;
      setInFlight(null);
      // A failure replaces the answer, so an action's failed reread never leaves the old state.
      setSaved(
        result._tag === "Success"
          ? { key: sentKey, value: result.value }
          : { key: sentKey, error: failureKind(squashAtomCommandFailure(result)) },
      );
    });
  };
  // A read and its answer belong to one unbroken period in which this task is the screen's and may
  // be looked up; a refresh does not end it. When it ends, a read's answer is ignored and what the
  // period read or failed is forgotten, so the next period reads again.
  const eligible = able && permitted && input.established && !input.holdsTask;
  // oxlint-disable-next-line goat/react-effect-budget -- Ends the period of a read when the screen's task, its eligibility or the screen itself goes.
  useEffect(() => {
    if (!eligible) return;
    return () => {
      if (running.current?.key === key) running.current = null;
      setInFlight((current) => (current?.key === key ? null : current));
      setSaved((current) => (current?.key === key ? null : current));
    };
  }, [eligible, key]);
  const readShown = useEffectEvent(read);
  // oxlint-disable-next-line goat/react-effect-budget -- Starts the read the decision asks for, once per decision.
  useEffect(() => {
    if (!decision.read || environmentId === null || taskId === null) return;
    readShown(environmentId, botId, taskId);
  }, [decision.read, environmentId, botId, taskId]);
  const present = (): MobileTaskLookup => {
    switch (decision.view) {
      case "off":
      case "row":
        return { state: "off" };
      case "denied":
        return { state: "denied" };
      case "loading":
        return { state: "loading" };
      case "answer":
        break;
    }
    const inFlightNow = inFlight?.key === key;
    if (saved === null || environmentId === null) return { state: "loading" };
    if ("error" in saved) {
      if (saved.error === "missing") return { state: "missing" };
      if (saved.error === "denied") return { state: "denied" };
      if (inFlightNow) return { state: "loading" };
      // Called through this wrapper, so a press event never reaches the read.
      return {
        state: "failed",
        retry: () => {
          if (taskId !== null) read(environmentId, botId, taskId);
        },
      };
    }
    const result = saved.value;
    if (result.task.state === "unavailable")
      return { state: "unavailable", task: result.task, result };
    const work = groupBotWork(
      [result.task.row, ...result.codingRows],
      input.childGroups,
      environmentId,
      result.remoteWork,
    );
    const task = [...work.inProgress, ...work.done][0];
    return task === undefined ? { state: "missing" } : { state: "known", task, result };
  };
  const invalidate = () => setStaleKey(key);
  return { lookup: present(), invalidate };
}
