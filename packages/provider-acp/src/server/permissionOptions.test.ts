import { expect, it } from "vite-plus/test";
import {
  selectAutoApprovedPermissionOption,
  selectPermissionOptionId,
} from "./permissionOptions.ts";

it("uses allow-once when always allow is unavailable and prefers it for auto approval", () => {
  const request = {
    sessionId: "session",
    toolCall: { toolCallId: "tool", title: "Run", kind: "execute" as const },
    options: [
      { optionId: "once", name: "Allow once", kind: "allow_once" as const },
      { optionId: "always", name: "Always allow", kind: "allow_always" as const },
    ],
  };
  expect(selectPermissionOptionId(request, "acceptForSession")).toBe("always");
  expect(selectAutoApprovedPermissionOption(request)).toBe("once");
  expect(
    selectPermissionOptionId(
      { ...request, options: request.options.slice(0, 1) },
      "acceptForSession",
    ),
  ).toBe("once");
});
