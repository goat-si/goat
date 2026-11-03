// @effect-diagnostics nodeBuiltinImport:off -- The synchronous source guard reads repository files.
import { assert, it } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import * as Statement from "effect/sql/Statement";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { HOT_SPANS, SQL_SPANS, makeLocalSpanPolicy } from "./tracePolicy.ts";

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
    readonly parent?: Tracer.AnySpan;
  } = {},
) => {
  const native = new Tracer.NativeSpan({
    name,
    parent: options.root ? Option.none() : Option.some(options.parent ?? parent),
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
const makeKeep = () => {
  const policy = makeLocalSpanPolicy();
  return (native: Tracer.NativeSpan) => policy(native, native.events);
};

it("keeps a fast parent when its recorded child ends first (#2465)", () => {
  const keep = makeKeep();
  const hotParent = span("SqliteWriter.send");
  const child = span("child", { parent: hotParent });
  assert.isTrue(keep(child));
  assert.isTrue(keep(hotParent));
});

it("marks a recorded child whose fast parent already ended (#2465)", () => {
  const keep = makeKeep();
  const hotParent = span("SqliteWriter.send");
  const child = span("child", { parent: hotParent });
  assert.isFalse(keep(hotParent));
  assert.isTrue(keep(child));
  assert.isTrue(child.attributes.get("trace.parent_omitted"));
});

const spanNames = (source: string) =>
  new Set(
    Array.from(
      source.matchAll(/\b(?:Effect\.)?(?:fn|withSpan|useSpan)\(\s*["']([^"']+)["']/g),
      (match) => match[1],
    ),
  );

it("does not count a policy span name that appears only in a comment (#2483)", () => {
  const names = spanNames('// Effect.fn("SqliteWriter.send")');
  assert.isFalse(names.has("SqliteWriter.send"));
});

it("keeps policy names aligned with span names in source (#2465)", () => {
  const root = NodePath.resolve(import.meta.dirname, "../../../..");
  const files = NodeFS.globSync(["apps/server/src/**/*.ts", "packages/*/src/**/*.ts"], {
    cwd: root,
    exclude: ["**/*.test.ts", "**/tracePolicy.ts"],
  });
  const names = new Set<string>();
  for (const file of files) {
    const source = NodeFS.readFileSync(NodePath.join(root, file), "utf8");
    for (const name of spanNames(source)) if (name) names.add(name);
  }
  for (const name of HOT_SPANS) assert.isTrue(names.has(name), name);
  const sqlite = NodeFS.readFileSync(
    NodePath.join(root, "packages/shared/src/nodeSqliteClient.ts"),
    "utf8",
  );
  assert.match(sqlite, /\[ATTR_DB_SYSTEM_NAME,\s*["']sqlite["']\]/);
  names.add(Statement.spanName([["db.system.name", "sqlite"]]));
  const sqlClient = NodeFS.readFileSync(
    NodeURL.fileURLToPath(import.meta.resolve("effect/sql/SqlClient")),
    "utf8",
  );
  for (const match of sqlClient.matchAll(/\b(?:Effect\.)?useSpan\(\s*["']([^"']+)["']/g)) {
    if (match[1]) names.add(match[1]);
  }
  for (const name of SQL_SPANS) assert.isTrue(names.has(name), name);
});

it("leaves out only fast successful hot spans and uncontended SQL", () => {
  const keep = makeKeep();
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
  const keep = makeKeep();
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
