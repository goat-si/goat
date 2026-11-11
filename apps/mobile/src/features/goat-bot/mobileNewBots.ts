import type { BotProfile, EnvironmentId } from "@goat/contracts";

import { uuidv4 } from "../../lib/uuid";
import { generatedBotName } from "./mobileNewBotNames";

// One-tap New bot. The create lives here, above the roster, so it outlives the list's mount: one
// per environment, its request id and name kept for a retry, its bot kept until the list has it.

export type NewBotOperation =
  | { readonly phase: "creating"; readonly clientRequestId: string; readonly name: string }
  | {
      readonly phase: "failed";
      readonly clientRequestId: string;
      readonly name: string;
      readonly failure: string;
    }
  | {
      readonly phase: "created";
      readonly clientRequestId: string;
      readonly name: string;
      readonly bot: BotProfile;
    };

/** Sends the create; resolves to the bot, or to the message to show. */
export type CreateNewBot = (name: string, clientRequestId: string) => Promise<BotProfile | string>;

const operations = new Map<EnvironmentId, NewBotOperation>();
const listeners = new Set<() => void>();
let opener: {
  readonly environmentId: EnvironmentId;
  readonly open: (bot: BotProfile) => void;
} | null = null;

function set(environmentId: EnvironmentId, next: NewBotOperation | null) {
  if (next === null) operations.delete(environmentId);
  else operations.set(environmentId, next);
  for (const listener of listeners) listener();
}

export function subscribeNewBots(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function newBotOperation(environmentId: EnvironmentId | null): NewBotOperation | null {
  return environmentId === null ? null : (operations.get(environmentId) ?? null);
}

/**
 * The roster, while it is the visible screen for this environment, opens the new chat when the
 * create answers. Registered only then; nothing opens once it is hidden or shows another one.
 */
export function registerNewBotOpener(
  environmentId: EnvironmentId,
  open: (bot: BotProfile) => void,
): () => void {
  const entry = { environmentId, open };
  opener = entry;
  return () => {
    if (opener === entry) opener = null;
  };
}

async function run(environmentId: EnvironmentId, create: CreateNewBot) {
  const sent = operations.get(environmentId);
  if (sent?.phase !== "creating") return;
  const { clientRequestId, name } = sent;
  const result = await create(name, clientRequestId).catch((error: unknown) =>
    error instanceof Error ? error.message : "Couldn't create a bot. Try again.",
  );
  // A dismissed or newer operation owns the slot now.
  if (operations.get(environmentId) !== sent) return;
  if (typeof result === "string") {
    set(environmentId, { phase: "failed", clientRequestId, name, failure: result });
    return;
  }
  // A retry can return a bot already deleted elsewhere: nothing opens; the list shows it there.
  if (result.state === "deleted") {
    set(environmentId, null);
    return;
  }
  set(environmentId, { phase: "created", clientRequestId, name, bot: result });
  if (opener?.environmentId === environmentId) opener.open(result);
}

/**
 * One tap: claims the environment's slot at once, so a second tap while one create runs does
 * nothing, and sends the create. False when one is already under way or waits to be dismissed.
 */
export function startNewBot(
  environmentId: EnvironmentId,
  members: ReadonlyArray<Pick<BotProfile, "name">>,
  create: CreateNewBot,
): boolean {
  if (operations.has(environmentId)) return false;
  set(environmentId, {
    phase: "creating",
    clientRequestId: uuidv4(),
    name: generatedBotName(members),
  });
  void run(environmentId, create);
  return true;
}

/** Sends a failed create again with the same request id and name, so the server answers once. */
export function retryNewBot(environmentId: EnvironmentId, create: CreateNewBot): void {
  const failed = operations.get(environmentId);
  if (failed?.phase !== "failed") return;
  set(environmentId, {
    phase: "creating",
    clientRequestId: failed.clientRequestId,
    name: failed.name,
  });
  void run(environmentId, create);
}

/** Ends a failed create; a later tap is a new request. */
export function dismissNewBot(environmentId: EnvironmentId): void {
  if (operations.get(environmentId)?.phase === "failed") set(environmentId, null);
}

/** The roster's list now holds the created bot, in any group: its own row takes over. */
export function settleListedNewBot(
  environmentId: EnvironmentId,
  listedIds: ReadonlySet<string>,
): void {
  const created = operations.get(environmentId);
  if (created?.phase === "created" && listedIds.has(created.bot.botId)) set(environmentId, null);
}
