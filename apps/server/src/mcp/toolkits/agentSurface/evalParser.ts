import type { AgentSurfaceRegistryEntry } from "@goat/contracts/agentSurface";
import { EVAL_LIMITS } from "@goat/contracts/agentSurface/eval";
import { isKeyedWrite, resolveAgentSurfaceEntry } from "@goat/contracts/agentSurface/resolve";

export type Json =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };

/** The program as read, before its forms are checked; stored so a run can resume without it. */
export type Node =
  | { readonly kind: "lit"; readonly value: Json }
  | { readonly kind: "sym"; readonly name: string }
  | { readonly kind: "kw"; readonly name: string }
  | { readonly kind: "list"; readonly items: ReadonlyArray<Node> }
  | { readonly kind: "vec"; readonly items: ReadonlyArray<Node> }
  | { readonly kind: "map"; readonly entries: ReadonlyArray<readonly [string, Node]> };

type Entry = AgentSurfaceRegistryEntry;

/** A checked expression. A call's site is its coordinate in the program. */
export type Expr =
  | { readonly t: "lit"; readonly v: Json }
  | { readonly t: "var"; readonly name: string }
  | { readonly t: "vec"; readonly items: ReadonlyArray<Expr> }
  | { readonly t: "obj"; readonly entries: ReadonlyArray<readonly [string, Expr]> }
  | { readonly t: "call"; readonly site: string; readonly entry: Entry; readonly args: Expr }
  | {
      readonly t: "let";
      readonly binds: ReadonlyArray<readonly [string, Expr]>;
      readonly body: ReadonlyArray<Expr>;
    }
  | { readonly t: "get" | "pick"; readonly target: Expr; readonly keys: ReadonlyArray<Expr> }
  | {
      readonly t: "map" | "filter";
      readonly site: string;
      readonly name: string;
      readonly coll: Expr;
      readonly body: Expr;
    }
  | { readonly t: "if"; readonly c: Expr; readonly a: Expr; readonly b: Expr | undefined }
  | { readonly t: "eq"; readonly a: Expr; readonly b: Expr }
  | { readonly t: "not"; readonly x: Expr }
  | { readonly t: "seq"; readonly items: ReadonlyArray<Expr> }
  | { readonly t: "try"; readonly body: Expr };

export interface CallSite {
  readonly site: string;
  readonly entry: Entry;
  /** The argument names, when the program spells them out. */
  readonly keys: ReadonlyArray<string> | undefined;
  readonly args: Expr;
  /** How many times it can run, counting each enclosing map at its full width. */
  readonly times: number;
}

export interface Program {
  readonly root: Expr;
  readonly sites: ReadonlyArray<CallSite>;
}

/** A program refused before anything ran; the code and reason go into the envelope as they are. */
export class ProgramRefusal extends Error {
  readonly code: "invalid_request" | "not_found" | "resource_exhausted";
  readonly reason: string;
  constructor(code: ProgramRefusal["code"], reason: string, message: string) {
    super(message);
    this.code = code;
    this.reason = reason;
  }
}

const parseError = (message: string) =>
  new ProgramRefusal("invalid_request", "eval_parse", message);
const formError = (message: string) => new ProgramRefusal("invalid_request", "eval_form", message);
const tooDeep = () =>
  new ProgramRefusal(
    "invalid_request",
    "eval_too_deep",
    `The program nests deeper than ${EVAL_LIMITS.depth} levels. Bind inner results with let.`,
  );

// Calling these from a program would only nest the same checks, or recurse. goat_eval is named
// here too, so a server that has not registered it yet still refuses it as a target.
const NOT_CALLABLE: ReadonlySet<string> = new Set([
  "surface.call",
  "surface.eval",
  "goat_eval",
  "goat_surface_eval",
]);
const DELIMITERS = new Set(["(", ")", "[", "]", "{", "}", '"', "'", ";", ","]);
const NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

const readText = (source: string): Node => {
  let at = 0;
  const skip = () => {
    while (at < source.length) {
      const char = source[at];
      if (char === ";") while (at < source.length && source[at] !== "\n") at += 1;
      else if (char === "," || /\s/.test(char ?? "")) at += 1;
      else return;
    }
  };
  const fail = (message: string): never => {
    throw parseError(`${message} at offset ${at}.`);
  };
  const read = (depth: number): Node => {
    skip();
    const char = source[at];
    if (char === undefined) return fail("The program ends before an expression");
    if (char === "(" || char === "[" || char === "{") {
      if (depth + 1 > EVAL_LIMITS.depth) throw tooDeep();
      const close = char === "(" ? ")" : char === "[" ? "]" : "}";
      at += 1;
      const items: Array<Node> = [];
      for (;;) {
        skip();
        if (at >= source.length) return fail(`Missing ${close}`);
        if (source[at] === close) break;
        items.push(read(depth + 1));
      }
      at += 1;
      if (char === "(") return { kind: "list", items };
      if (char === "[") return { kind: "vec", items };
      if (items.length % 2 !== 0) return fail("A map needs a value for every key");
      const entries: Array<readonly [string, Node]> = [];
      for (let index = 0; index < items.length; index += 2) {
        const key = items[index];
        const value = items[index + 1];
        if (key === undefined || value === undefined) break;
        if (key.kind === "kw") entries.push([key.name, value]);
        else if (key.kind === "lit" && typeof key.value === "string")
          entries.push([key.value, value]);
        else return fail("A map key is a string or a :keyword");
      }
      return { kind: "map", entries };
    }
    if (char === ")" || char === "]" || char === "}") return fail(`Unexpected ${char}`);
    if (char === "'") {
      at += 1;
      if (depth + 1 > EVAL_LIMITS.depth) throw tooDeep();
      return { kind: "list", items: [{ kind: "sym", name: "quote" }, read(depth + 1)] };
    }
    if (char === '"') {
      const start = at;
      at += 1;
      while (at < source.length && source[at] !== '"') at += source[at] === "\\" ? 2 : 1;
      if (at >= source.length) return fail("Missing closing quote");
      at += 1;
      try {
        return { kind: "lit", value: JSON.parse(source.slice(start, at)) as string };
      } catch {
        return fail("A string has an invalid escape");
      }
    }
    const start = at;
    while (at < source.length && !DELIMITERS.has(source[at] ?? "") && !/\s/.test(source[at] ?? ""))
      at += 1;
    const token = source.slice(start, at);
    if (token.startsWith(":")) {
      if (token.length === 1) return fail("A keyword needs a name");
      return { kind: "kw", name: token.slice(1) };
    }
    if (token === "true" || token === "false") return { kind: "lit", value: token === "true" };
    if (token === "null" || token === "nil") return { kind: "lit", value: null };
    if (/^-?[0-9]/.test(token)) {
      if (!NUMBER.test(token)) return fail(`${token} is not a number`);
      const value = Number(token);
      // A literal that overflows would read back as null from the journal and change branches.
      if (!Number.isFinite(value)) return fail(`${token} is too large`);
      return { kind: "lit", value };
    }
    return { kind: "sym", name: token };
  };
  const node = read(0);
  skip();
  if (at < source.length) fail("A program is one expression; wrap several in (seq ...)");
  return node;
};

const readJson = (value: unknown, depth: number): Node => {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return { kind: "lit", value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw parseError("A number must be finite.");
    return { kind: "lit", value };
  }
  if (typeof value !== "object") throw parseError("A JSON program holds only JSON values.");
  if (depth + 1 > EVAL_LIMITS.depth) throw tooDeep();
  if (Array.isArray(value)) {
    const [head, ...rest] = value as ReadonlyArray<unknown>;
    // A list whose first item is not a name only appears where a form reads it, as let's pairs.
    const items =
      typeof head === "string"
        ? [{ kind: "sym", name: head } as const, ...rest.map((item) => readJson(item, depth + 1))]
        : value.map((item: unknown) => readJson(item, depth + 1));
    return { kind: "list", items };
  }
  return {
    kind: "map",
    entries: Object.entries(value).map(([key, item]) => [key, readJson(item, depth + 1)] as const),
  };
};

/** UTF-8 bytes of the program as sent. */
const programBytes = (program: string | ReadonlyArray<unknown>) =>
  Buffer.byteLength(typeof program === "string" ? program : JSON.stringify(program), "utf8");

export const readProgram = (program: string | ReadonlyArray<unknown>): Node => {
  if (programBytes(program) > EVAL_LIMITS.programBytes)
    throw new ProgramRefusal(
      "invalid_request",
      "eval_too_large",
      `The program is over ${EVAL_LIMITS.programBytes} bytes. Pass large data as bindings.`,
    );
  return typeof program === "string" ? readText(program) : readJson(program, 0);
};

/** A quoted node as data: symbols become their names, keywords keep their colon. */
const quoted = (node: Node): Json => {
  switch (node.kind) {
    case "lit":
      return node.value;
    case "sym":
      return node.name;
    case "kw":
      return `:${node.name}`;
    case "list":
    case "vec":
      return node.items.map(quoted);
    case "map":
      return Object.fromEntries(node.entries.map(([key, value]) => [key, quoted(value)]));
  }
};

const nameOf = (node: Node | undefined, form: string): string => {
  if (node?.kind === "sym") return node.name;
  if (node?.kind === "lit" && typeof node.value === "string") return node.value;
  throw formError(`${form} needs a name here.`);
};

/**
 * Checks every form and call target, so a program that cannot run is refused before it calls
 * anything. Scoping is static: every variable is bound by let, map, filter or the run's bindings.
 */
export const analyzeProgram = (node: Node, bindingNames: ReadonlyArray<string>): Program => {
  const sites: Array<CallSite> = [];
  const visit = (
    node: Node,
    path: string,
    scope: ReadonlySet<string>,
    times: number,
    pure: boolean,
  ): Expr => {
    const child = (
      item: Node,
      index: number,
      inner = scope,
      innerTimes = times,
      innerPure = pure,
    ) => visit(item, `${path}.${index}`, inner, innerTimes, innerPure);
    switch (node.kind) {
      case "lit":
        return { t: "lit", v: node.value };
      case "kw":
        return { t: "lit", v: node.name };
      case "sym":
        if (!scope.has(node.name))
          throw new ProgramRefusal(
            "invalid_request",
            "eval_unbound",
            `${node.name} is not bound. Bind it with let, or quote it ('${node.name}) for a string.`,
          );
        return { t: "var", name: node.name };
      case "vec":
        return { t: "vec", items: node.items.map((item, index) => child(item, index)) };
      case "map":
        return {
          t: "obj",
          entries: node.entries.map(([key, value], index) => [key, child(value, index)] as const),
        };
      case "list":
        break;
    }
    const [head, ...rest] = node.items;
    if (head?.kind !== "sym")
      throw formError('A form starts with its name, such as (thread.read :threadId "t1").');
    const arg = (index: number, inner = scope, innerTimes = times, innerPure = pure) => {
      const item = rest[index];
      if (item === undefined) throw formError(`${head.name} is missing an argument.`);
      return child(item, index + 1, inner, innerTimes, innerPure);
    };
    const arity = (min: number, max = min) => {
      if (rest.length < min || rest.length > max)
        throw formError(
          `${head.name} takes ${min === max ? min : `${min} to ${max === Infinity ? "any" : max}`} arguments.`,
        );
    };
    switch (head.name) {
      case "quote":
        arity(1);
        return { t: "lit", v: quoted(rest[0] as Node) };
      case "var": {
        arity(1);
        const name = nameOf(rest[0], "var");
        if (!scope.has(name))
          throw new ProgramRefusal("invalid_request", "eval_unbound", `${name} is not bound.`);
        return { t: "var", name };
      }
      case "list":
        return { t: "vec", items: rest.map((_, index) => arg(index)) };
      case "let": {
        arity(2, Infinity);
        const spec = rest[0];
        const pairs: ReadonlyArray<readonly [string, Node, number]> =
          spec?.kind === "map"
            ? spec.entries.map(([name, value], index) => [name, value, index] as const)
            : spec?.kind === "list" || spec?.kind === "vec"
              ? spec.items.map((pair, index) => {
                  const items = pair.kind === "list" || pair.kind === "vec" ? pair.items : [];
                  if (items.length !== 2)
                    throw formError("let binds pairs: (let ((name expr) ...) body).");
                  return [nameOf(items[0], "let"), items[1] as Node, index] as const;
                })
              : [];
        if (pairs.length === 0) throw formError("let binds pairs: (let ((name expr) ...) body).");
        let inner = new Set(scope);
        const binds = pairs.map(([name, value, index]) => {
          const expr = visit(value, `${path}.1.${index}`, inner, times, pure);
          inner = new Set(inner).add(name);
          return [name, expr] as const;
        });
        const body = rest.slice(1).map((item, index) => child(item, index + 2, inner));
        return { t: "let", binds, body };
      }
      case ".":
      case "get":
      case "pick":
        arity(2, Infinity);
        return {
          t: head.name === "pick" ? "pick" : "get",
          target: arg(0),
          keys: rest.slice(1).map((_, index) => arg(index + 1)),
        };
      case "map":
      case "filter": {
        arity(3);
        const name = nameOf(rest[0], head.name);
        const inner = new Set(scope).add(name);
        const coll = arg(1);
        const body =
          head.name === "map"
            ? arg(2, inner, times * EVAL_LIMITS.mapWidth)
            : arg(2, inner, times, true);
        return { t: head.name, site: path, name, coll, body };
      }
      case "if":
        arity(2, 3);
        return { t: "if", c: arg(0), a: arg(1), b: rest.length === 3 ? arg(2) : undefined };
      case "eq":
        arity(2);
        return { t: "eq", a: arg(0), b: arg(1) };
      case "not":
        arity(1);
        return { t: "not", x: arg(0) };
      case "seq":
        arity(1, Infinity);
        return { t: "seq", items: rest.map((_, index) => arg(index)) };
      case "try":
        arity(1);
        return { t: "try", body: arg(0) };
      case "call":
        arity(1, Infinity);
        return call(nameOf(rest[0], "call"), rest.slice(1), 2);
      default:
        return call(head.name, rest, 1);
    }

    function call(target: string, args: ReadonlyArray<Node>, offset: number): Expr {
      if (NOT_CALLABLE.has(target))
        throw new ProgramRefusal(
          "invalid_request",
          "not_callable",
          `${target} cannot run inside a program.`,
        );
      const entry = resolveAgentSurfaceEntry(target);
      if (entry === undefined)
        throw new ProgramRefusal(
          "not_found",
          "unknown_path",
          `No form or GOAT path is named ${target}. Search paths with goat_describe { query }.`,
        );
      if (NOT_CALLABLE.has(entry.path))
        throw new ProgramRefusal(
          "invalid_request",
          "not_callable",
          `${entry.path} cannot run inside a program.`,
        );
      if (pure)
        throw formError(`A filter predicate cannot call ${entry.path}; call it before filtering.`);
      const at = (item: Node, index: number) => child(item, index + offset);
      const keywords =
        args.length % 2 === 0 && args.every((item, index) => index % 2 === 1 || item.kind === "kw");
      let argsExpr: Expr;
      let keys: ReadonlyArray<string> | undefined;
      if (args.length === 0) {
        argsExpr = { t: "obj", entries: [] };
        keys = [];
      } else if (keywords) {
        const entries: Array<readonly [string, Expr]> = [];
        for (let index = 0; index < args.length; index += 2) {
          const key = args[index];
          const value = args[index + 1];
          if (key?.kind !== "kw" || value === undefined) break;
          entries.push([key.name, at(value, index + 1)]);
        }
        argsExpr = { t: "obj", entries };
        keys = entries.map(([key]) => key);
      } else if (args.length === 1) {
        argsExpr = at(args[0] as Node, 0);
        keys = argsExpr.t === "obj" ? argsExpr.entries.map(([key]) => key) : undefined;
      } else throw formError(`Pass ${entry.path}'s arguments as :key value pairs or as one map.`);
      if (keys?.includes("clientRequestId") && isKeyedWrite(entry)) throw explicitKey(entry.path);
      sites.push({ site: path, entry, keys, args: argsExpr, times });
      return { t: "call", site: path, entry, args: argsExpr };
    }
  };
  const root = visit(node, "r", new Set(bindingNames), 1, false);
  if (sites.length > EVAL_LIMITS.calls)
    throw new ProgramRefusal(
      "resource_exhausted",
      "eval_call_limit",
      `The program has ${sites.length} calls; a run makes at most ${EVAL_LIMITS.calls}.`,
    );
  return { root, sites };
};

/** A program may not pick a keyed write's key: each is derived from its run and step. */
export const explicitKey = (path: string) =>
  new ProgramRefusal(
    "invalid_request",
    "eval_explicit_key",
    `Remove clientRequestId from ${path}: goat_eval derives a keyed write's key from its run and step.`,
  );
