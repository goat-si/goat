import type { BotProfile, EnvironmentId } from "@goat/contracts";

import { uuidv4 } from "../../lib/uuid";
import { generatedBotName } from "./mobileNewBotNames";

// One-tap New bot. A create lives here, above the roster, so it outlives the list's mount: one
// per environment while it runs or waits to be retried. A created bot frees the slot at once and
// keeps a row until the list holds it or the person dismisses it.

export type NewBotOperation =
  | { readonly phase: "creating"; readonly clientRequestId: string; readonly name: string }
  | {
      readonly phase: "failed";
      readonly clientRequestId: string;
      readonly name: string;
      readonly failure: string;
    };

/** Sends the create; resolves to the bot, or to the message to show. */
export type CreateNewBot = (name: string, clientRequestId: string) => Promise<BotProfile | string>;

/**
 * Opens the created bot's chat if the person is still where they tapped; it decides from what is
 * true when the server answers.
 */
export type OpenIfStillHere = (bot: BotProfile) => void;

interface Slot {
  readonly operation: NewBotOperation | null;
  readonly created: ReadonlyArray<BotProfile>;
}

const EMPTY: Slot = { operation: null, created: [] };
const slots = new Map<EnvironmentId, Slot>();
const intents = new Map<EnvironmentId, OpenIfStillHere>();
const listeners = new Set<() => void>();

function set(environmentId: EnvironmentId, next: Slot) {
  if (next.operation === null && next.created.length === 0) slots.delete(environmentId);
  else slots.set(environmentId, next);
  for (const listener of listeners) listener();
}
const slotOf = (environmentId: EnvironmentId) => slots.get(environmentId) ?? EMPTY;

export function subscribeNewBots(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function newBotSlot(environmentId: EnvironmentId | null): Slot {
  return environmentId === null ? EMPTY : slotOf(environmentId);
}

async function run(environmentId: EnvironmentId, create: CreateNewBot) {
  const sent = slotOf(environmentId).operation;
  if (sent?.phase !== "creating") return;
  const { clientRequestId, name } = sent;
  const result = await create(name, clientRequestId).catch((error: unknown) =>
    error instanceof Error ? error.message : "Couldn't create a bot. Try again.",
  );
  // A dismissed, forgotten or newer operation owns the slot now.
  const slot = slotOf(environmentId);
  if (slot.operation !== sent) return;
  if (typeof result === "string") {
    set(environmentId, {
      ...slot,
      operation: { phase: "failed", clientRequestId, name, failure: result },
    });
    return;
  }
  const open = intents.get(environmentId);
  intents.delete(environmentId);
  // A retry can return a bot already deleted elsewhere: nothing opens; the list shows it there.
  if (result.state === "deleted") {
    set(environmentId, { ...slot, operation: null });
    return;
  }
  set(environmentId, {
    operation: null,
    created: [...slot.created.filter((bot) => bot.botId !== result.botId), result],
  });
  open?.(result);
}

/**
 * One tap: claims the environment's slot at once, so a second tap while one create runs does
 * nothing, and sends the create. False when one is under way or waits to be retried.
 */
export function startNewBot(
  environmentId: EnvironmentId,
  members: ReadonlyArray<Pick<BotProfile, "name">>,
  create: CreateNewBot,
  open: OpenIfStillHere,
): boolean {
  const slot = slotOf(environmentId);
  if (slot.operation !== null) return false;
  intents.set(environmentId, open);
  // Bots created a moment ago may not be in the list yet; their names are taken too.
  set(environmentId, {
    ...slot,
    operation: {
      phase: "creating",
      clientRequestId: uuidv4(),
      name: generatedBotName([...members, ...slot.created]),
    },
  });
  void run(environmentId, create);
  return true;
}

/** Sends a failed create again with the same request id and name, so the server answers once. */
export function retryNewBot(
  environmentId: EnvironmentId,
  create: CreateNewBot,
  open: OpenIfStillHere,
): void {
  const slot = slotOf(environmentId);
  const failed = slot.operation;
  if (failed?.phase !== "failed") return;
  intents.set(environmentId, open);
  set(environmentId, {
    ...slot,
    operation: { phase: "creating", clientRequestId: failed.clientRequestId, name: failed.name },
  });
  void run(environmentId, create);
}

/** Ends a failed create; a later tap is a new request. */
export function dismissNewBot(environmentId: EnvironmentId): void {
  const slot = slotOf(environmentId);
  if (slot.operation?.phase === "failed") set(environmentId, { ...slot, operation: null });
}

/** Removes a created bot's row before the list has it. */
export function dismissCreatedBot(environmentId: EnvironmentId, botId: string): void {
  const slot = slotOf(environmentId);
  set(environmentId, { ...slot, created: slot.created.filter((bot) => bot.botId !== botId) });
}

/** The roster's list now holds these bots, in any group: their own rows take over. */
export function settleListedNewBots(
  environmentId: EnvironmentId,
  listedIds: ReadonlySet<string>,
): void {
  const slot = slotOf(environmentId);
  const created = slot.created.filter((bot) => !listedIds.has(bot.botId));
  if (created.length !== slot.created.length) set(environmentId, { ...slot, created });
}

/** Environments the app no longer has (removed, or signed out): their creates are forgotten. */
export function forgetNewBots(keep: ReadonlySet<string>): void {
  for (const environmentId of slots.keys()) {
    if (keep.has(environmentId)) continue;
    intents.delete(environmentId);
    set(environmentId, EMPTY);
  }
}
