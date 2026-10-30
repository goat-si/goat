import type { ComputerUseHistoryEntry } from "@goat/contracts";

type Entry = typeof ComputerUseHistoryEntry.Type;

const timeFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

export function historyRows(entries: ReadonlyArray<Entry>) {
  return entries.map((entry) => ({
    id: entry.id,
    time: timeFormat.format(entry.recordedAt),
    target:
      entry.targetKind === "tab"
        ? entry.tabHost || "Unknown host"
        : entry.appId && entry.appName
          ? `${entry.appName} (${entry.appId})`
          : entry.appName || entry.appId || "Unknown app",
    method: entry.method,
    label: entry.targetLabel,
    verdict: entry.verdict,
    refusal: entry.refusalCode,
    typed:
      entry.typedText !== null
        ? entry.typedText
        : entry.typedLength === null
          ? null
          : `${entry.typedLength} characters`,
  }));
}
