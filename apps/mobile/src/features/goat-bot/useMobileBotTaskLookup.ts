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
  /** The saved answer is this task's. */
  readonly held: boolean;
  /** This task's last read failed and nothing has answered since. */
  readonly failed: boolean;
  /** An action on this task completed after its last read started. */
  readonly stale: boolean;
  /** A read for this task is running. */
  readonly inFlight: boolean;
};

/**
 * What the task screen shows, and whether a read starts by itself. Nothing else starts a read
 * except Try again; so a task change during a refresh waits for it, an action's reread waits for
 * its refresh to settle (success or failure), and a refresh that returns the task reads nothing.
 */
export function taskLookupDecision(facts: TaskLookupFacts): {
  readonly view: "off" | "row" | "denied" | "answer" | "failed" | "loading";
  readonly read: boolean;
} {
  if (!facts.able || !facts.established) return { view: "off", read: false };
  if (facts.holdsTask) return { view: "row", read: false };
  if (!facts.permitted) return { view: "denied", read: false };
  // A failed read waits for Try again, as an answer waits for an action to make it stale.
  const read =
    !facts.refreshing && !facts.inFlight && (facts.stale || (!facts.held && !facts.failed));
  if (facts.held) return { view: "answer", read };
  if (facts.failed && !facts.inFlight) return { view: "failed", read };
  return { view: "loading", read };
}

type Saved = {
  readonly key: string;
  readonly value?: BotWorkResult;
  readonly missing?: boolean;
  readonly denied?: boolean;
};

/** A refusal by the server's access check, at the transport or by the channel gateway. */
function refused(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  if ("_tag" in error && error._tag === "EnvironmentAuthorizationError") return true;
  return "reason" in error && error.reason === "forbidden";
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
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [staleKey, setStaleKey] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState<{ key: string; generation: number } | null>(null);
  // The read in flight, for the answer's check and for a second press before the screen renders.
  const running = useRef<{ key: string; generation: number } | null>(null);
  const generation = useRef(0);
  // A refresh that returns the task drops its saved answer; a mark for a task left behind goes.
  if (input.established && input.holdsTask && (saved?.key === key || failedKey === key)) {
    setSaved(null);
    setFailedKey(null);
  }
  if (staleKey !== null && staleKey !== key) setStaleKey(null);
  const decision = taskLookupDecision({
    able,
    permitted,
    established: input.established,
    refreshing: input.refreshing,
    holdsTask: input.holdsTask,
    held: saved?.key === key,
    failed: failedKey === key,
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
      if (result._tag === "Success") {
        setFailedKey(null);
        setSaved({ key: sentKey, value: result.value });
        return;
      }
      const error = squashAtomCommandFailure(result);
      if (
        typeof error === "object" &&
        error !== null &&
        "reason" in error &&
        error.reason === "not_found"
      ) {
        setFailedKey(null);
        setSaved({ key: sentKey, missing: true });
      } else if (refused(error)) {
        setFailedKey(null);
        setSaved({ key: sentKey, denied: true });
      } else setFailedKey(sentKey);
    });
  };
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
      case "failed":
        // Called through this wrapper, so a press event never reaches the read.
        return {
          state: "failed",
          retry: () => {
            if (environmentId !== null && taskId !== null) read(environmentId, botId, taskId);
          },
        };
      case "answer":
        break;
    }
    if (saved === null || saved.missing) return { state: "missing" };
    if (saved.denied) return { state: "denied" };
    const result = saved.value;
    if (result === undefined || environmentId === null) return { state: "missing" };
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
