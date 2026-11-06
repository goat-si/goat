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
import { parseSync } from "vite-plus";
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

const productionSource = (file: string) =>
  !/(?:^|\/)(?:__tests__|__fixtures__|tests?|testing|testkits?|fixtures?|test[-_]?utils|[^/]*-testing)(?:\/|\.)/i.test(
    file,
  ) &&
  !/(?:\.test(?:\.|$)|\.spec(?:\.|$)|testkit|fixtures?|test[-_]?utils|^test)/i.test(
    NodePath.basename(file),
  );

const nodes = (source: string, filename = "source.ts") => {
  const parsed = parseSync(filename, source);
  assert.deepEqual(parsed.errors, [], filename);
  const result: Record<string, unknown>[] = [];
  const pending: unknown[] = [parsed.program];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) pending.push(...value);
    else if (value && typeof value === "object") {
      const node = value as Record<string, unknown>;
      if (typeof node.type === "string") result.push(node);
      pending.push(...Object.values(node));
    }
  }
  return result;
};

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const spanNames = (source: string, filename = "source.ts") => {
  const names = new Set<string>();
  for (const node of nodes(source, filename)) {
    if (node.type !== "CallExpression" || !Array.isArray(node.arguments)) continue;
    const callee = object(node.callee);
    const receiver = object(callee.object);
    const property = object(callee.property);
    const declaration =
      (callee.type === "MemberExpression" &&
        !callee.computed &&
        receiver.name === "Effect" &&
        ["fn", "withSpan", "useSpan"].includes(String(property.name))) ||
      (callee.type === "Identifier" && ["withSpan", "useSpan"].includes(String(callee.name)));
    const argument = object(node.arguments[0]);
    if (declaration && argument.type === "Literal" && typeof argument.value === "string") {
      names.add(argument.value);
    }
  }
  return names;
};

it("does not count a policy span name that appears only in a comment (#2483)", () => {
  const names = spanNames(`
    // Effect.fn("SqliteWriter.send")
    /* Effect.withSpan("SqliteWriter.send") */
    const text = 'Effect.fn("SqliteWriter.send")';
    Effect.fnUntraced("SqliteWriter.send");
    Effect.fn("real")(() => {});
    Effect.withSpan("also-real");
  `);
  assert.isFalse(names.has("SqliteWriter.send"));
  assert.deepEqual([...names].sort(), ["also-real", "real"]);
});

it("only scans production sources for policy spans (#2483)", () => {
  for (const file of [
    "apps/server/src/example.test.ts",
    "apps/server/src/example.testkit.ts",
    "apps/server/src/example.fixture.ts",
    "apps/server/src/testing/example.ts",
    "apps/server/src/testkit/example.ts",
    "apps/server/src/__fixtures__/example.ts",
    "packages/provider-testing/src/example.ts",
  ])
    assert.isFalse(productionSource(file), file);
  assert.isTrue(productionSource("apps/server/src/observability/Observability.ts"));
});

it("keeps policy names aligned with span names in source (#2465)", () => {
  const root = NodePath.resolve(import.meta.dirname, "../../../..");
  const files = NodeFS.globSync(["apps/server/src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"], {
    cwd: root,
    exclude: ["**/*.test.ts", "**/tracePolicy.ts"],
  });
  const names = new Set<string>();
  for (const file of files) {
    if (!productionSource(file)) continue;
    const source = NodeFS.readFileSync(NodePath.join(root, file), "utf8");
    if (![...HOT_SPANS].some((name) => source.includes(name))) continue;
    for (const name of spanNames(source, file)) names.add(name);
  }
  for (const name of HOT_SPANS) assert.isTrue(names.has(name), name);
  const sqlNames = new Set<string>();
  const sqlite = NodeFS.readFileSync(
    NodePath.join(root, "packages/shared/src/nodeSqliteClient.ts"),
    "utf8",
  );
  assert.isTrue(
    nodes(sqlite).some((node) => {
      if (node.type !== "Property" || object(node.key).name !== "spanAttributes") return false;
      const value = object(node.value);
      if (value.type !== "ArrayExpression" || !Array.isArray(value.elements)) return false;
      return value.elements.some((element) => {
        const pair = object(element);
        if (pair.type !== "ArrayExpression" || !Array.isArray(pair.elements)) return false;
        return (
          object(pair.elements[0]).name === "ATTR_DB_SYSTEM_NAME" &&
          object(pair.elements[1]).value === "sqlite"
        );
      });
    }),
  );
  sqlNames.add(Statement.spanName([["db.system.name", "sqlite"]]));
  const sqlClient = NodeFS.readFileSync(
    NodeURL.fileURLToPath(import.meta.resolve("effect/sql/SqlClient")),
    "utf8",
  );
  for (const name of spanNames(sqlClient, "SqlClient.js")) sqlNames.add(name);
  for (const name of SQL_SPANS) assert.isTrue(sqlNames.has(name), name);
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
    "an interrupted hot span": span("SqliteWriter.send", {
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
