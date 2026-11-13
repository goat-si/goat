/**
 * Two readings of OpenCodex's link counters subtract only under the same epoch and generation;
 * a delta spreads evenly over the time between them. Relay or direct bytes need the same route,
 * classified, at both readings. At most MAX_LINKS series of SLOTS five-minute slots are held.
 * Only pairs at most MAX_PAIR_MS apart count as measured time; a longer gap is averaged.
 */
export const SLOT_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
// One slot more than a day, so the oldest partial slot of a 24-hour window is still held.
const SLOTS = DAY_MS / SLOT_MS + 1;
const MAX_LINKS = 256;
// Readings come only while something reads host status: a longer gap spreads its bytes evenly.
const MAX_PAIR_MS = SLOT_MS;
const FIELDS = 10;
const [
  TO_HOME,
  FROM_HOME,
  RELAY_TO_HOME,
  RELAY_FROM_HOME,
  DIRECT_TO_HOME,
  DIRECT_FROM_HOME,
  MEASURED,
  AVERAGED,
  UNCOUNTED,
  WEBSOCKET,
] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export interface LinkTrafficCounters {
  readonly epoch: string;
  readonly generation: number;
  readonly toHomeBytes: number;
  readonly fromHomeBytes: number;
  /** Requests whose body OpenCodex could not count (no Content-Length); absent when not reported. */
  readonly toHomeUncounted?: number | undefined;
}

export interface LinkTrafficReading {
  readonly linkId: string;
  readonly traffic: LinkTrafficCounters;
  /** A link WebSocket was open at this reading; OpenCodex counts none of its payloads. */
  readonly webSocket?: boolean | undefined;
  /** The route in use at this reading; undefined when none is proven or it is not reported. */
  readonly route?: { readonly name: string; readonly via?: "relay" | "direct" } | undefined;
}

export interface LinkTrafficWindow {
  readonly toHomeBytes: number;
  readonly fromHomeBytes: number;
  readonly relayToHomeBytes: number;
  readonly relayFromHomeBytes: number;
  readonly directToHomeBytes: number;
  readonly directFromHomeBytes: number;
  /** Time covered by readings at most one slot apart. */
  readonly measuredMs: number;
  /** Time covered by longer gaps, whose bytes are averaged over the gap. */
  readonly averagedMs: number;
  /** Requests in the window whose body bytes are missing from toHomeBytes. */
  readonly uncountedRequests: number;
  /** Time in the window between readings where a link WebSocket was open at either one. */
  readonly webSocketMs: number;
}

export interface LinkTrafficView {
  readonly hour: LinkTrafficWindow;
  readonly day: LinkTrafficWindow;
}

interface Last extends LinkTrafficCounters {
  readonly at: number;
  /** "relay:name" or "direct:name"; undefined when no route is classified. */
  readonly routeKey: string | undefined;
  readonly webSocket: boolean;
}

interface Series {
  last: Last;
  readonly values: Float64Array;
  readonly slotOf: Float64Array;
}

const routeKeyOf = (reading: LinkTrafficReading) =>
  reading.route?.via === undefined ? undefined : `${reading.route.via}:${reading.route.name}`;

const pairs = (last: Last, next: LinkTrafficCounters, at: number) =>
  at > last.at &&
  last.epoch === next.epoch &&
  last.generation === next.generation &&
  next.toHomeBytes >= last.toHomeBytes &&
  next.fromHomeBytes >= last.fromHomeBytes;

const add = (values: Float64Array, index: number, amount: number) => {
  values[index] = (values[index] ?? 0) + amount;
};

/** Adds amounts spread evenly over [from, to) into the slots that interval overlaps. */
function spread(series: Series, from: number, to: number, amounts: ReadonlyArray<number>) {
  const length = to - from;
  const first = Math.max(Math.floor(from / SLOT_MS), Math.floor(to / SLOT_MS) - SLOTS + 1);
  for (let slot = first; slot * SLOT_MS < to; slot += 1) {
    const overlap = Math.min(to, (slot + 1) * SLOT_MS) - Math.max(from, slot * SLOT_MS);
    if (overlap <= 0) continue;
    const index = slot % SLOTS;
    if (series.slotOf[index] !== slot) {
      series.slotOf[index] = slot;
      series.values.fill(0, index * FIELDS, index * FIELDS + FIELDS);
    }
    for (let field = 0; field < FIELDS; field += 1)
      add(series.values, index * FIELDS + field, ((amounts[field] ?? 0) * overlap) / length);
  }
}

/** The window ending at `at`. */
function sum(series: Series, at: number, windowMs: number): LinkTrafficWindow {
  const totals = new Float64Array(FIELDS);
  const start = at - windowMs;
  const last = Math.floor(at / SLOT_MS);
  const first = Math.floor(start / SLOT_MS);
  for (let slot = first; slot <= last; slot += 1) {
    const index = slot % SLOTS;
    if (series.slotOf[index] !== slot) continue;
    // Bytes are taken as even within a slot; only the oldest one straddles the window's start.
    const inside = slot === first ? ((slot + 1) * SLOT_MS - start) / SLOT_MS : 1;
    for (let field = 0; field < FIELDS; field += 1)
      add(totals, field, (series.values[index * FIELDS + field] ?? 0) * inside);
  }
  const whole = (field: number) => Math.round(totals[field] ?? 0);
  return {
    toHomeBytes: whole(TO_HOME),
    fromHomeBytes: whole(FROM_HOME),
    relayToHomeBytes: whole(RELAY_TO_HOME),
    relayFromHomeBytes: whole(RELAY_FROM_HOME),
    directToHomeBytes: whole(DIRECT_TO_HOME),
    directFromHomeBytes: whole(DIRECT_FROM_HOME),
    measuredMs: Math.min(windowMs, whole(MEASURED)),
    averagedMs: Math.min(windowMs, whole(AVERAGED)),
    uncountedRequests: Math.max(0, Math.ceil((totals[UNCOUNTED] ?? 0) - 1e-9)),
    webSocketMs: whole(WEBSOCKET),
  };
}

export function makeLinkTrafficBook(maxLinks = MAX_LINKS) {
  const book = new Map<string, Series>();

  /** Room for a new link: the stalest one this pass does not report gives way, else none does. */
  const admit = (inPass: ReadonlySet<string>) => {
    if (book.size < maxLinks) return true;
    // A Map iterates in insertion order and each reading re-inserts its link: the first is the stalest.
    for (const linkId of book.keys()) {
      if (inPass.has(linkId)) continue;
      book.delete(linkId);
      return true;
    }
    return false;
  };

  const record = (reading: LinkTrafficReading, at: number, inPass: ReadonlySet<string>) => {
    const next: Last = {
      ...reading.traffic,
      at,
      routeKey: routeKeyOf(reading),
      webSocket: reading.webSocket === true,
    };
    const series = book.get(reading.linkId);
    if (series === undefined) {
      if (!admit(inPass)) return;
      book.set(reading.linkId, {
        last: next,
        values: new Float64Array(SLOTS * FIELDS),
        slotOf: new Float64Array(SLOTS).fill(-1),
      });
    } else {
      // An older reading than the last one held carries nothing new.
      if (at < series.last.at) return;
      const { last } = series;
      if (pairs(last, next, at)) {
        const toHome = next.toHomeBytes - last.toHomeBytes;
        const fromHome = next.fromHomeBytes - last.fromHomeBytes;
        const same = last.routeKey !== undefined && last.routeKey === next.routeKey;
        const relay = same && next.routeKey?.startsWith("relay:") === true;
        const direct = same && next.routeKey?.startsWith("direct:") === true;
        const gap = at - last.at;
        const uncounted =
          last.toHomeUncounted === undefined || next.toHomeUncounted === undefined
            ? 0
            : Math.max(0, next.toHomeUncounted - last.toHomeUncounted);
        spread(series, last.at, at, [
          toHome,
          fromHome,
          relay ? toHome : 0,
          relay ? fromHome : 0,
          direct ? toHome : 0,
          direct ? fromHome : 0,
          gap <= MAX_PAIR_MS ? gap : 0,
          gap <= MAX_PAIR_MS ? 0 : gap,
          uncounted,
          last.webSocket || next.webSocket ? gap : 0,
        ]);
      } else if (at > last.at && (last.webSocket || next.webSocket)) {
        // Counters that reset still leave a WebSocket's uncounted time in the window.
        const websocketOnly = Array.from({ length: FIELDS }, (_, field) =>
          field === WEBSOCKET ? at - last.at : 0,
        );
        spread(series, last.at, at, websocketOnly);
      }
      series.last = next;
      book.delete(reading.linkId);
      book.set(reading.linkId, series);
    }
  };

  const prune = (at: number) => {
    for (const [linkId, series] of book)
      if (series.last.at < at - DAY_MS - SLOT_MS) book.delete(linkId);
  };

  return {
    /** Records one `ocx link status` pass taken at `at` (epoch ms). */
    observe(readings: ReadonlyArray<LinkTrafficReading>, at: number) {
      prune(at);
      const inPass = new Set(readings.map(({ linkId }) => linkId));
      for (const reading of readings) record(reading, at, inPass);
    },
    /** The last hour and day for a link; undefined before its first paired reading. */
    view(linkId: string, at: number): LinkTrafficView | undefined {
      const series = book.get(linkId);
      if (series === undefined) return undefined;
      const day = sum(series, at, DAY_MS);
      if (day.measuredMs + day.averagedMs === 0) return undefined;
      return { hour: sum(series, at, HOUR_MS), day };
    },
    /** Relay bytes both ways in the last 24 hours over every link held, including removed ones. */
    relayDayBytes(at: number) {
      let total = 0;
      for (const series of book.values()) {
        const day = sum(series, at, DAY_MS);
        total += day.relayToHomeBytes + day.relayFromHomeBytes;
      }
      return total;
    },
    size: () => book.size,
  };
}
