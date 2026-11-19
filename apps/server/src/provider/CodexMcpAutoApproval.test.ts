import { assert, it } from "@effect/vitest";
import { canAutoApproveMcpElicitation } from "./CodexMcpElicitation.ts";

it("does not infer user choices from ordinary required enums", () => {
  assert.isFalse(
    canAutoApproveMcpElicitation({
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: { choice: { type: "string", enum: ["allow", "deny"] } },
        required: ["choice"],
      },
    }),
  );
});

it("rejects persistent defaults and ambiguous scope choices", () => {
  const payload = (field: unknown) => ({
    mode: "form",
    requestedSchema: { type: "object", properties: { approval: field }, required: ["approval"] },
  });
  assert.isFalse(
    canAutoApproveMcpElicitation(
      payload({ type: "string", enum: ["once", "always"], default: "always" }),
    ),
  );
  assert.isFalse(
    canAutoApproveMcpElicitation(
      payload({ type: "string", enum: ["once", "allow_once", "always"] }),
    ),
  );
  assert.isFalse(
    canAutoApproveMcpElicitation({
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: { remember: { type: "boolean", default: true } },
        required: ["remember"],
      },
    }),
  );
});
