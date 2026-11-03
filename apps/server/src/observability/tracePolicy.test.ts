import { assert, it } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import { keepLocalSpan } from "./tracePolicy.ts";

const parent = Tracer.externalSpan({ traceId: "trace", spanId: "parent" });
const span = (
  name: string,
  options: {
    readonly root?: boolean;
    readonly wait?: unknown;
    readonly endNanos?: bigint;
    readonly exit?: Exit.Exit<unknown, unknown>;
    readonly events?: ReadonlyArray<string>;
    readonly attributes?: Record<string, unknown>;
    readonly unfinished?: boolean;
  } = {},
) => {
  const native = new Tracer.NativeSpan({
    name,
    parent: options.root ? Option.none() : Option.some(parent),
    annotations: Context.empty(),
    links: [],
    startTime: 0n,
    kind: "internal",
    sampled: true,
  });
  if ("wait" in options) native.attribute("db.lock_wait_ms", options.wait);
  for (const [key, value] of Object.entries(options.attributes ?? {})) native.attribute(key, value);
  for (const event of options.events ?? []) native.event(event, 0n, {});
  if (!options.unfinished) native.end(options.endNanos ?? 1_000_000n, options.exit ?? Exit.void);
  return native;
};
const keep = (native: Tracer.NativeSpan) => keepLocalSpan(native, native.events);

it("leaves out only fast successful hot spans and uncontended SQL", () => {
  assert.isFalse(keep(span("SqliteWriter.send")));
  assert.isFalse(keep(span("OpenCodexQuotaPool.routeOf")));
  assert.isFalse(keep(span("sqlite", { wait: 0 })));
  assert.isFalse(
    keep(span("sql.transaction", { wait: 0.5, events: ["effect.sql.transaction.commit"] })),
  );
  assert.isFalse(
    keep(span("sql.transaction", { wait: 0, events: ["effect.sql.transaction.savepoint"] })),
  );
});

it("keeps every span that carries evidence", () => {
  const kept = {
    "an unlisted name": span("ProviderTurnStartService.start"),
    "a slow hot span": span("SqliteWriter.send", { endNanos: 10_000_000n }),
    "a failed hot span": span("SqliteWriter.send", { exit: Exit.fail("fixture") }),
    "an interrupted hot span": span("ThreadLiveEventCoalescer.offerAll", {
      exit: Exit.interrupt(),
    }),
    "a root hot span": span("SqliteWriter.send", { root: true }),
    "a hot span with an event": span("SqliteWriter.send", { events: ["warning"] }),
    "a hot span with a routine SQL event name": span("SqliteWriter.send", {
      events: ["effect.sql.transaction.commit"],
    }),
    "a hot span with heap growth": span("SqliteWriter.send", {
      attributes: { "memory.heap_growth_bytes": 20_000_000 },
    }),
    "an unfinished hot span": span("SqliteWriter.send", { unfinished: true }),
    "a negative duration": span("SqliteWriter.send", { endNanos: -1n }),
    "a rolled back transaction": span("sql.transaction", {
      wait: 0,
      events: ["effect.sql.transaction.rollback"],
    }),
    "a lock wait": span("sqlite", { wait: 1 }),
    "a slow statement": span("sqlite", { wait: 0, endNanos: 10_000_000n }),
    "a root statement": span("sqlite", { wait: 0, root: true }),
    "a statement without a recorded wait": span("sqlite"),
  };
  for (const [label, native] of Object.entries(kept)) assert.isTrue(keep(native), label);
  for (const wait of [NaN, Infinity, -1, "0", null]) {
    assert.isTrue(keep(span("sqlite", { wait })), String(wait));
  }
});
