import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import { keepLocalSqlSpan } from "./tracePolicy.ts";

it("keeps failed, slow, waiting, eventful and root SQL spans and suppresses only fast successes", () => {
  const parent = Tracer.externalSpan({ traceId: "trace", spanId: "parent" });
  const make = (name = "sqlite", root = false) => {
    const span = new Tracer.NativeSpan({
      name,
      parent: root ? Option.none() : Option.some(parent),
      annotations: Context.empty(),
      links: [],
      startTime: 0n,
      kind: "client",
      root,
      sampled: true,
    });
    span.attribute("db.lock_wait_ms", 0);
    return span;
  };
  const fast = make();
  fast.attribute("db.lock_wait_ms", 0);
  fast.end(1_000_000n, Exit.void);
  assert.isFalse(keepLocalSqlSpan(fast));
  const tx = make("sql.transaction");
  tx.attribute("db.lock_wait_ms", 0);
  tx.end(1_000_000n, Exit.void);
  assert.isFalse(keepLocalSqlSpan(tx));
  const slow = make();
  slow.attribute("db.lock_wait_ms", 0);
  slow.end(10_000_000n, Exit.void);
  const failed = make();
  failed.attribute("db.lock_wait_ms", 0);
  failed.end(1n, Exit.fail("fixture"));
  const interrupted = make();
  interrupted.end(1n, Exit.interrupt());
  const waiting = make();
  waiting.attribute("db.lock_wait_ms", 1);
  waiting.end(1n, Exit.void);
  const root = make("sqlite", true);
  root.end(1n, Exit.void);
  const service = make("service");
  service.end(1n, Exit.void);
  const eventful = make();
  eventful.attribute("db.lock_wait_ms", 0);
  eventful.event("warning", 0n, {});
  eventful.end(1n, Exit.void);
  const unknownWait = make();
  unknownWait.attributes.delete("db.lock_wait_ms");
  unknownWait.end(1n, Exit.void);
  const unfinished = make();
  const negative = make();
  negative.end(-1n, Exit.void);
  for (const wait of [NaN, Infinity, -1, "0", null]) {
    const invalid = make();
    invalid.attribute("db.lock_wait_ms", wait);
    invalid.end(1n, Exit.void);
    assert.isTrue(keepLocalSqlSpan(invalid));
  }
  for (const span of [
    slow,
    failed,
    interrupted,
    waiting,
    root,
    service,
    eventful,
    unknownWait,
    unfinished,
    negative,
  ]) {
    assert.isTrue(keepLocalSqlSpan(span));
  }
});
