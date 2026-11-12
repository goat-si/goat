import type { BotProfile, EnvironmentId } from "@goat/contracts";

import { generatedBotName } from "./newBotNames.ts";

// New bot in one press. A create lives here, above the roster, so it outlives the list's mount: one
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
 * Opens the created bot's chat if the person is still where they started it; it decides from what
 * is true when the server answers. It belongs to the surface that started the create.
 */
export type OpenIfStillHere = (bot: BotProfile, sentTo: EnvironmentId) => void;

interface Slot {
  readonly operation: NewBotOperation | null;
  readonly created: ReadonlyArray<BotProfile>;
}

const EMPTY: Slot = { operation: null, created: [] };
const slots = new Map<EnvironmentId, Slot>();
// The pending open of each environment's create, with the roster mount that made it.
const intents = new Map<
  EnvironmentId,
  { readonly open: OpenIfStillHere; readonly owner: object }
>();
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
    intents.delete(environmentId);
    set(environmentId, {
      ...slot,
      operation: { phase: "failed", clientRequestId, name, failure: result },
    });
    return;
  }
  const open = intents.get(environmentId)?.open;
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
  open?.(result, environmentId);
}

/**
 * One press: claims the environment's slot at once, so a second press while one create runs does
 * nothing, and sends the create. False when one is under way or waits to be retried.
 */
export function startNewBot(
  environmentId: EnvironmentId,
  members: ReadonlyArray<Pick<BotProfile, "name">>,
  create: CreateNewBot,
  open: OpenIfStillHere,
  owner: object,
  newRequestId: () => string,
): boolean {
  const slot = slotOf(environmentId);
  if (slot.operation !== null) return false;
  intents.set(environmentId, { open, owner });
  // Bots created a moment ago may not be in the list yet; their names are taken too.
  set(environmentId, {
    ...slot,
    operation: {
      phase: "creating",
      clientRequestId: newRequestId(),
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
  owner: object,
): void {
  const slot = slotOf(environmentId);
  const failed = slot.operation;
  if (failed?.phase !== "failed") return;
  intents.set(environmentId, { open, owner });
  set(environmentId, {
    ...slot,
    operation: { phase: "creating", clientRequestId: failed.clientRequestId, name: failed.name },
  });
  void run(environmentId, create);
}

/** Ends a failed create; a later press is a new request. */
export function dismissNewBot(environmentId: EnvironmentId): void {
  const slot = slotOf(environmentId);
  if (slot.operation?.phase !== "failed") return;
  intents.delete(environmentId);
  set(environmentId, { ...slot, operation: null });
}

/** The surface that started the create has gone: its create answers into the list, opening nothing. */
export function forgetNewBotIntentsOf(owner: object): void {
  for (const [environmentId, intent] of intents)
    if (intent.owner === owner) intents.delete(environmentId);
}

/** Removes a created bot's row before the list has it. */
export function dismissCreatedBot(environmentId: EnvironmentId, botId: string): void {
  const slot = slotOf(environmentId);
  set(environmentId, { ...slot, created: slot.created.filter((bot) => bot.botId !== botId) });
}

/** An edit answered for a created bot the list may not hold yet: its row and chat show the edit. */
export function replaceCreatedBot(environmentId: EnvironmentId, bot: BotProfile): void {
  const slot = slotOf(environmentId);
  if (!slot.created.some((created) => created.botId === bot.botId)) return;
  set(environmentId, {
    ...slot,
    created: slot.created.map((created) => (created.botId === bot.botId ? bot : created)),
  });
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

/** The environment left the app (removed, or signed out): its create and rows are forgotten. */
export function forgetNewBotEnvironment(environmentId: EnvironmentId): void {
  intents.delete(environmentId);
  if (slots.has(environmentId)) set(environmentId, EMPTY);
}
