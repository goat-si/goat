import type { GoatBotDelivery } from "./rows.ts";

/** The one status line under the newest sent message. Failed sends have their own UI. */
export function goatBotReceiptLabel(
  delivery: GoatBotDelivery,
  formatTime: (iso: string) => string,
): { readonly text: string; readonly accessibleText: string } | null {
  switch (delivery.state) {
    case "queued":
      return { text: "Waiting to send", accessibleText: "Waiting to send" };
    case "sending":
      return { text: "Sending…", accessibleText: "Sending" };
    case "sent":
      return { text: "Sent", accessibleText: "Sent to GOAT Bot" };
    case "delivered":
      return { text: "Delivered", accessibleText: "Delivered to GOAT Bot" };
    case "read": {
      const time = formatTime(delivery.readAt);
      return { text: `Read ${time}`, accessibleText: `Read by GOAT Bot at ${time}` };
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

/** A local-calendar stamp, repeated after a long pause even on the same day. */
export function goatBotStampParts(
  iso: string,
  nowMs: number,
  formatTime: (iso: string) => string,
): { lead: string; time: string } {
  // @effect-diagnostics-next-line globalDate:off - stamps follow the device's local calendar.
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { lead: "", time: "" };
  // @effect-diagnostics-next-line globalDate:off - stamps follow the device's local calendar.
  const now = new Date(nowMs);
  const calendarDay = (value: Date) =>
    Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  const days = Math.round((calendarDay(now) - calendarDay(date)) / 86_400_000);
  const time = formatTime(iso);
  if (days === 0) return { lead: "Today", time };
  if (days === 1) return { lead: "Yesterday", time };
  if (days > 1 && days <= 6) return { lead: weekday.format(date), time };
  return { lead: `${older.format(date)} at`, time };
}

export function formatGoatBotStamp(
  iso: string,
  nowMs: number,
  formatTime: (iso: string) => string,
): string {
  const { lead, time } = goatBotStampParts(iso, nowMs, formatTime);
  return lead ? `${lead} ${time}` : "";
}
