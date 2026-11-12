import type { GoatBotDelivery, GoatBotRow } from "./rows.ts";

/** A send the server refused. The chat renders it with the bot's current name. */
export const GOAT_BOT_NOT_ACCEPTED = "not_accepted";

/** A question's choices read A, B, C…; past Z they count on as numbers. */
export function goatBotChoiceLetter(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

/** The composer's hint while a question in view still takes a pick; null otherwise. */
export function goatBotOpenQuestionPlaceholder(rows: ReadonlyArray<GoatBotRow>): string | null {
  return rows.some((row) => row.kind === "bot" && row.options.length > 0)
    ? "Answer, or ask something else"
    : null;
}

export function goatBotRejectionText(reason: string | undefined, botName: string): string {
  return reason === GOAT_BOT_NOT_ACCEPTED
    ? `${botName} did not accept this message`
    : (reason ?? "Not Delivered");
}

/** The one status line under the newest sent message. Failed sends have their own UI. */
export function goatBotReceiptLabel(
  delivery: GoatBotDelivery,
  formatTime: (iso: string) => string,
  botName = "GOAT Bot",
): { readonly text: string; readonly accessibleText: string } | null {
  switch (delivery.state) {
    case "queued":
      return { text: "Waiting to send", accessibleText: "Waiting to send" };
    case "sending":
      return { text: "Sending…", accessibleText: "Sending" };
    case "sent":
      return { text: "Sent", accessibleText: `Sent to ${botName}` };
    case "delivered":
      return { text: "Delivered", accessibleText: `Delivered to ${botName}` };
    case "read": {
      const time = formatTime(delivery.readAt);
      return { text: `Read ${time}`, accessibleText: `Read by ${botName} at ${time}` };
    }
    case "failed":
      return null;
  }
}

const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const older = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});
const olderWithYear = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** Whole local-calendar days from `iso` to now; null for an unreadable time. */
function calendarDaysAgo(
  iso: string,
  nowMs: number,
): { date: Date; now: Date; days: number } | null {
  // @effect-diagnostics-next-line globalDate:off - stamps follow the device's local calendar.
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  // @effect-diagnostics-next-line globalDate:off - stamps follow the device's local calendar.
  const now = new Date(nowMs);
  const calendarDay = (value: Date) =>
    Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  return { date, now, days: Math.round((calendarDay(now) - calendarDay(date)) / 86_400_000) };
}

/**
 * "Today", "Yesterday", a weekday within the week, or the date, on the device's calendar.
 * `yearWhenOther` adds the year to a date from another year.
 */
export function goatBotDayLabel(
  iso: string,
  nowMs: number,
  options?: { readonly yearWhenOther?: boolean },
): string {
  const at = calendarDaysAgo(iso, nowMs);
  if (at === null) return "";
  if (at.days === 0) return "Today";
  if (at.days === 1) return "Yesterday";
  if (at.days > 1 && at.days <= 6) return weekday.format(at.date);
  return options?.yearWhenOther === true && at.date.getFullYear() !== at.now.getFullYear()
    ? olderWithYear.format(at.date)
    : older.format(at.date);
}

/** The local calendar date of `iso` as YYYY-MM-DD; empty for an unreadable time. */
export function goatBotLocalDate(iso: string): string {
  // @effect-diagnostics-next-line globalDate:off - days follow the device's local calendar.
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A local-calendar stamp, repeated after a long pause even on the same day. */
export function goatBotStampParts(
  iso: string,
  nowMs: number,
  formatTime: (iso: string) => string,
): { lead: string; time: string } {
  const at = calendarDaysAgo(iso, nowMs);
  if (at === null) return { lead: "", time: "" };
  const lead = goatBotDayLabel(iso, nowMs);
  return { lead: at.days >= 0 && at.days <= 6 ? lead : `${lead} at`, time: formatTime(iso) };
}

export function formatGoatBotStamp(
  iso: string,
  nowMs: number,
  formatTime: (iso: string) => string,
): string {
  const { lead, time } = goatBotStampParts(iso, nowMs, formatTime);
  return lead ? `${lead} ${time}` : "";
}
