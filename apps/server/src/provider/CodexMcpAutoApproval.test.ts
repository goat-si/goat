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

it("only auto-accepts exact known schemas or an empty confirmation", () => {
  const approve = (requestedSchema: unknown) =>
    canAutoApproveMcpElicitation({ mode: "form", requestedSchema });
  assert.isTrue(
    approve({
      type: "object",
      properties: { approval: { type: "string", enum: ["once", "always"] } },
      required: ["approval"],
    }),
  );
  assert.isTrue(approve({ type: "object", properties: {}, required: [] }));
  assert.isFalse(
    approve({
      type: "object",
      properties: {
        duration: {
          type: "string",
          title: "Duration",
          enum: ["once", "always"],
          default: "always",
        },
      },
      required: ["duration"],
    }),
  );
  assert.isFalse(
    approve({
      type: "object",
      properties: {
        save: { type: "boolean", title: "Save this approval for later", default: true },
      },
      required: ["save"],
    }),
  );
  assert.isFalse(
    approve({
      type: "object",
      properties: {
        frequency: { type: "string", title: "Frequency of backups", enum: ["once", "always"] },
      },
      required: ["frequency"],
    }),
  );
  assert.isFalse(
    approve({
      type: "object",
      properties: {
        approval: { type: "string", enum: ["once", "always"] },
        extra: { type: "string" },
      },
      required: ["approval"],
    }),
  );
});
