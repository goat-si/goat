import { assert, describe, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";

import { extractAntigravityElicitationForm } from "../../provider/acp/AntigravityProtocol.ts";

describe("AntigravityAdapterV2 ask_question elicitation form", () => {
  it("shows each ask_question question as the question body, not the generic form message", () => {
    // agy's ask_question puts each question in its field's title, with no description,
    // and a generic count in the form message.
    const choice = (title: string) => ({
      type: "string",
      title,
      oneOf: [
        { const: "npm", title: "npm" },
        { const: "pnpm", title: "pnpm" },
      ],
    });
    const form = extractAntigravityElicitationForm({
      sessionId: "session-1",
      mode: "form",
      message: "The agent has 2 questions.",
      requestedSchema: {
        type: "object",
        properties: {
          q0: choice("Which package manager should this new TypeScript project use?"),
          q0_other: { type: "string", title: "Other" },
          q1: choice("Which package manager should the docs site use?"),
          q1_other: { type: "string", title: "Other" },
        },
      },
    } as EffectAcpSchema.CreateElicitationRequest);
    assert.deepEqual(
      form?.questions.map((question) => question.question),
      [
        "Which package manager should this new TypeScript project use?",
        "Which package manager should the docs site use?",
      ],
    );
    for (const question of form?.questions ?? []) {
      assert.notStrictEqual(question.header, question.question);
    }
  });
});
