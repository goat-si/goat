import { defineRule, type ESTree } from "@oxlint/plugins";

import {
  allowance,
  budgetFor,
  countLines,
  isBudgeted,
  readBaseline,
  repoPath,
  unsafeAssertion,
  MAX_LINES,
  type Baseline,
} from "../codeBudget.ts";

const GUIDE = "See docs/operations/code-quality.md.";

const describeKind = { nonNull: "non-null assertions (`x!`)", asAny: "casts to `any`" } as const;
const newKindMessage = {
  nonNull: "New non-null assertions (`x!`) are not allowed outside tests.",
  asAny: "New casts to `any` are not allowed.",
} as const;

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Hold file length, non-null assertions, and casts to `any` to the checked-in baseline so they only shrink.",
    },
    schema: [
      {
        type: "object",
        properties: { baseline: { type: "object" } },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const file = repoPath(context.filename);
    if (!isBudgeted(file)) return {};
    const options = context.options[0] as { readonly baseline?: Baseline } | undefined;
    const allowed = allowance(file, budgetFor(options?.baseline ?? readBaseline(), file));
    const found = { nonNull: [] as Array<ESTree.Node>, asAny: [] as Array<ESTree.Node> };

    const record = (node: ESTree.Node) => {
      const kind = unsafeAssertion(node);
      if (kind) found[kind].push(node);
    };

    return {
      TSNonNullExpression: record,
      TSAsExpression: record,
      TSTypeAssertion: record,
      "Program:exit"(program: ESTree.Program) {
        const lines = countLines(context.sourceCode.text);
        if (lines > allowed.lines) {
          context.report({
            node: program,
            message:
              allowed.lines > MAX_LINES
                ? `This file has ${lines} lines and may not grow past its recorded ${allowed.lines}. Move the new code into its own module. ${GUIDE}`
                : `This file has ${lines} lines; files may not exceed ${MAX_LINES}. Split it along a responsibility boundary. ${GUIDE}`,
          });
        }
        for (const kind of ["nonNull", "asAny"] as const) {
          const nodes = found[kind];
          if (nodes.length <= allowed[kind]) continue;
          // Without a baseline every occurrence is new, so point at each one.
          const reported = allowed[kind] === 0 ? nodes : nodes.slice(-1);
          for (const node of reported) {
            context.report({
              node,
              message:
                allowed[kind] === 0
                  ? `${newKindMessage[kind]} Narrow the type instead. ${GUIDE}`
                  : `This file has ${nodes.length} ${describeKind[kind]}; its baseline allows ${allowed[kind]}. Narrow the type instead. ${GUIDE}`,
            });
          }
        }
      },
    };
  },
});
