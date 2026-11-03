import { defineRule, type ESTree, type Variable } from "@oxlint/plugins";

const tracked: Record<string, readonly string[]> = {
  "node:child_process": ["spawn", "fork"],
  "node:readline": ["createInterface"],
  "node:readline/promises": ["createInterface"],
  "node:net": ["createServer", "createConnection", "connect", "Socket", "Server"],
  "node:tls": ["connect", "createServer"],
  "node:http": ["request", "get", "createServer"],
  "node:https": ["request", "get", "createServer"],
  "node:fs": ["createReadStream", "createWriteStream", "watch"],
  "node:tty": ["ReadStream", "WriteStream"],
  "node:worker_threads": ["Worker"],
  ws: ["WebSocket", "WebSocketServer"],
  "@effect/platform-node/NodeSocket": ["NodeWS.WebSocket"],
};
const message =
  "Create this emitter inside guardErrors/guardChild from @goat/shared/errorGuards so its 'error' is heard from the start; an unheard 'error' ends the whole process.";
const INVOKERS = ["call", "apply", "bind"];

const propertyName = (node: ESTree.MemberExpression): string | undefined =>
  !node.computed && node.property.type === "Identifier"
    ? node.property.name
    : node.property.type === "Literal" && typeof node.property.value === "string"
      ? node.property.value
      : undefined;

export default defineRule({
  meta: { type: "problem", docs: { description: "Guard error emitters at creation." } },
  create(context) {
    const bindings = new Map<Variable, string>();
    const guards = new Set<Variable>();
    const variable = (id: ESTree.Node & { name: string }): Variable | undefined => {
      let scope = context.sourceCode.getScope(id);
      while (true) {
        const found = scope.set.get(id.name);
        if (found || !scope.upper) return found;
        scope = scope.upper;
      }
    };
    const unwrap = (node: ESTree.Node): ESTree.Node => {
      while (
        node.type === "TSAsExpression" ||
        node.type === "TSSatisfiesExpression" ||
        node.type === "TSNonNullExpression" ||
        node.type === "ParenthesizedExpression"
      )
        node = node.expression;
      return node;
    };
    const path = (input: ESTree.Node): string | undefined => {
      const node = unwrap(input);
      if (node.type === "Identifier") {
        const binding = variable(node);
        return binding ? bindings.get(binding) : undefined;
      }
      if (node.type === "MemberExpression") {
        const base = path(node.object);
        const name = propertyName(node);
        return base && name ? `${base}.${name}` : undefined;
      }
      if (node.type === "AwaitExpression") return path(node.argument);
      if (
        node.type === "ImportExpression" &&
        node.source.type === "Literal" &&
        typeof node.source.value === "string"
      )
        return tracked[node.source.value] ? node.source.value : undefined;
      if (
        node.type === "CallExpression" &&
        node.arguments[0]?.type === "Literal" &&
        typeof node.arguments[0].value === "string"
      ) {
        const source = node.arguments[0].value;
        if (
          tracked[source] &&
          ((node.callee.type === "Identifier" && node.callee.name === "require") ||
            (node.callee.type === "CallExpression" &&
              node.callee.callee.type === "Identifier" &&
              node.callee.callee.name === "createRequire"))
        )
          return source;
      }
      return undefined;
    };
    const isTracked = (node: ESTree.Node): boolean => {
      const value = path(node);
      return (
        value !== undefined &&
        Object.entries(tracked).some(([module, members]) =>
          members.some((member) => value === `${module}.${member}`),
        )
      );
    };
    const hasTracked = (input: ESTree.Node): boolean => {
      const node = unwrap(input);
      if (isTracked(node)) return true;
      if (node.type === "LogicalExpression") return hasTracked(node.left) || hasTracked(node.right);
      if (node.type === "ConditionalExpression")
        return hasTracked(node.consequent) || hasTracked(node.alternate);
      if (node.type === "MemberExpression" && INVOKERS.includes(propertyName(node) ?? ""))
        return hasTracked(node.object);
      return false;
    };
    const guarded = (node: ESTree.Node): boolean => {
      let current = node;
      while (current.parent && unwrap(current.parent) === node) current = current.parent;
      const parent = current.parent;
      if (
        !parent ||
        parent.type !== "CallExpression" ||
        parent.arguments[0] !== current ||
        parent.callee.type !== "Identifier"
      )
        return false;
      const binding = variable(parent.callee);
      return binding !== undefined && guards.has(binding);
    };
    const report = (node: ESTree.Node) => context.report({ node, message });
    const creation = (node: ESTree.CallExpression | ESTree.NewExpression) => {
      if (!hasTracked(node.callee)) return;
      const callee = unwrap(node.callee);
      const bind = callee.type === "MemberExpression" && propertyName(callee) === "bind";
      if (bind || !guarded(node)) report(node);
    };
    const value = (node: ESTree.Node) => {
      if (!isTracked(node)) return;
      const owner = node.parent;
      if (
        node.type === "Identifier" &&
        ((owner?.type === "MemberExpression" && owner.property === node && !owner.computed) ||
          (owner?.type === "Property" && owner.key === node && !owner.shorthand))
      )
        return;
      let current: ESTree.Node = node;
      while (current.parent) {
        const parent: ESTree.Node = current.parent;
        if (
          parent.type.startsWith("TS") &&
          parent.type !== "TSAsExpression" &&
          parent.type !== "TSSatisfiesExpression" &&
          parent.type !== "TSNonNullExpression"
        )
          return;
        if (parent.type.startsWith("Import")) return;
        // A local const alias is tracked where it is called; an exported or reassignable one escapes.
        if (parent.type === "VariableDeclarator") {
          const declaration = parent.parent;
          const exported = declaration?.parent?.type === "ExportNamedDeclaration";
          if (
            declaration?.type === "VariableDeclaration" &&
            declaration.kind === "const" &&
            !exported
          )
            return;
          break;
        }
        // Reading a member such as .prototype, or testing instanceof/typeof, creates nothing.
        if (parent.type === "MemberExpression" && parent.object === current) {
          if (!INVOKERS.includes(propertyName(parent) ?? "")) return;
          current = parent;
          continue;
        }
        if (parent.type === "BinaryExpression" && parent.operator === "instanceof") return;
        if (parent.type === "UnaryExpression" && parent.operator === "typeof") return;
        if (
          parent.type === "LogicalExpression" ||
          parent.type === "ConditionalExpression" ||
          unwrap(parent) === current
        ) {
          current = parent;
          continue;
        }
        if (
          (parent.type === "CallExpression" || parent.type === "NewExpression") &&
          parent.callee === current
        )
          return;
        break;
      }
      report(node);
    };
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (typeof source !== "string") return;
        for (const spec of node.specifiers) {
          const binding = context.sourceCode
            .getDeclaredVariables(node)
            .find((item) => item.name === spec.local.name);
          if (!binding) continue;
          if (spec.type === "ImportSpecifier") {
            const name =
              spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
            if (
              (source === "@goat/shared/errorGuards" ||
                ((source === "./errorGuards" || source === "./errorGuards.ts") &&
                  context.filename.replaceAll("\\", "/").includes("/packages/shared/"))) &&
              (name === "guardErrors" || name === "guardChild")
            )
              guards.add(binding);
            if (tracked[source] && typeof name === "string")
              bindings.set(binding, `${source}.${name}`);
          } else if (tracked[source]) {
            bindings.set(
              binding,
              source === "ws" && spec.type === "ImportDefaultSpecifier" ? "ws.WebSocket" : source,
            );
          }
        }
      },
      VariableDeclarator(node) {
        if (!node.init) return;
        const base = path(node.init);
        if (!base) return;
        const variables = context.sourceCode.getDeclaredVariables(node);
        if (node.id.type === "Identifier") {
          const name = node.id.name;
          const binding = variables.find((item) => item.name === name);
          if (binding) bindings.set(binding, base);
        } else if (node.id.type === "ObjectPattern") {
          for (const property of node.id.properties) {
            if (
              property.type !== "Property" ||
              property.key.type !== "Identifier" ||
              property.value.type !== "Identifier"
            )
              continue;
            const local = property.value.name;
            const binding = variables.find((item) => item.name === local);
            if (binding) bindings.set(binding, `${base}.${property.key.name}`);
          }
        }
      },
      CallExpression: creation,
      NewExpression: creation,
      MemberExpression: value,
      Identifier: value,
    };
  },
});
