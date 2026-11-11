import type { BotProfile } from "@goat/contracts";

const GENERATED_NAME = /^New bot(?: ([2-9]|[1-9]\d+))?$/;

/** "New bot", or "New bot 2", "New bot 3"… the first no member uses, hidden and deleted included. */
export function generatedBotName(members: ReadonlyArray<Pick<BotProfile, "name">>): string {
  const used = new Set(members.map((member) => member.name));
  if (!used.has("New bot")) return "New bot";
  for (let number = 2; ; number += 1) {
    const name = `New bot ${number}`;
    if (!used.has(name)) return name;
  }
}

/** Whether a name is one generatedBotName gives, so the bot still waits for a real one. */
export function isGeneratedBotName(name: string): boolean {
  return GENERATED_NAME.test(name);
}
