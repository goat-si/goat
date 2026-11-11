import type { BotProfile } from "@goat/contracts";

// One formatter makes every generated name; recognising one asks the same formatter.
const BASE = "New bot";
const generatedName = (number: number) => (number === 1 ? BASE : `${BASE} ${number}`);

/** "New bot", or "New bot 2", "New bot 3"… the first no member uses, hidden and deleted included. */
export function generatedBotName(members: ReadonlyArray<Pick<BotProfile, "name">>): string {
  const used = new Set(members.map((member) => member.name));
  for (let number = 1; ; number += 1) {
    const name = generatedName(number);
    if (!used.has(name)) return name;
  }
}

/** Whether a name is one generatedBotName gives, so the bot still waits for a real one. */
export function isGeneratedBotName(name: string): boolean {
  if (name === generatedName(1)) return true;
  const number = Number(name.slice(BASE.length + 1));
  return Number.isSafeInteger(number) && number >= 2 && generatedName(number) === name;
}
