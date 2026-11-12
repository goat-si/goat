import type { GoatBotEventSubject } from "@goat/contracts";

/**
 * Where an event line names its subject. Server lines read "<Kind> <name> <change>", so the name
 * is searched after the first word: "Routine Routine paused" chips the second "Routine". A line
 * without the name there has no chip.
 */
export function goatBotEventSubjectSpan(row: {
  readonly text: string;
  readonly subject?: GoatBotEventSubject | undefined;
}): { readonly before: string; readonly name: string; readonly after: string } | undefined {
  const name = row.subject?.name;
  if (name === undefined) return undefined;
  const at = row.text.indexOf(name, row.text.indexOf(" ") + 1);
  if (at < 0) return undefined;
  return {
    before: row.text.slice(0, at),
    name,
    after: row.text.slice(at + name.length),
  };
}
