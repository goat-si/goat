import type { GoatBotEventSubject } from "@goat/contracts";

/**
 * Where an event line names its subject. Server lines read "<Kind> <name> <change>", so the name
 * is searched after the first word first ("Routine Routine paused" chips the second "Routine"),
 * then anywhere, so a line that starts with its subject keeps its chip. No name, no chip.
 */
export function goatBotEventSubjectSpan(row: {
  readonly text: string;
  readonly subject?: GoatBotEventSubject | undefined;
}): { readonly before: string; readonly name: string; readonly after: string } | undefined {
  const name = row.subject?.name;
  if (name === undefined) return undefined;
  const afterFirstWord = row.text.indexOf(name, row.text.indexOf(" ") + 1);
  const at = afterFirstWord >= 0 ? afterFirstWord : row.text.indexOf(name);
  if (at < 0) return undefined;
  return {
    before: row.text.slice(0, at),
    name,
    after: row.text.slice(at + name.length),
  };
}
