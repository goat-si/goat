import { describe, expect, it } from "@effect/vitest";
import { BUILTIN_PERMISSION_PROFILES, GoatclawRole } from "@goat/contracts";
import {
  GOATCLAW_LANE_DEFAULTS,
  GOATCLAW_REPORT_PROTOCOL,
  goatclawRoleBrief,
  goatclawRoleTemplate,
} from "./RoleTemplates.ts";

describe("goatclaw role templates", () => {
  it.each(GoatclawRole.literals)("%s launches under a built-in profile", (role) => {
    expect(BUILTIN_PERMISSION_PROFILES[goatclawRoleTemplate(role).profileId]).toBeDefined();
  });

  it("gives merge authority only to the merge manager and owner-held supervisor", () => {
    const merges = (role: GoatclawRole) =>
      BUILTIN_PERMISSION_PROFILES[goatclawRoleTemplate(role).profileId]!.capabilities.includes(
        "pr.merge",
      );
    expect(merges("merge-manager")).toBe(true);
    expect(merges("domain-manager")).toBe(false);
    expect(merges("issue-sweeper")).toBe(false);
    // The supervisor holds owner but is read-only by its instructions.
    expect(goatclawRoleTemplate("supervisor").preamble).toContain("change nothing yourself");
  });

  it("states the merge policy and the close-the-issue rule where merges happen", () => {
    const merge = goatclawRoleTemplate("merge-manager").preamble;
    expect(merge).toContain("gh pr merge <pr> --admin --squash --match-head-commit <head-sha>");
    expect(merge).toContain("goat-ci-result is SUCCESS on its exact current head");
    expect(merge).toContain("Do not rebase or update the branch because dev moved");
    expect(merge).toContain("When goat-ci on dev fails, stop merging");
    for (const role of ["merge-manager", "issue-sweeper"] as const)
      expect(goatclawRoleTemplate(role).preamble).toContain(
        "After a pull request merges into dev, close each issue it fixes yourself",
      );
    expect(goatclawRoleTemplate("issue-sweeper").preamble).toContain("You do not merge");
  });

  it("puts the lane defaults and the shared report protocol between the preamble and the task", () => {
    const brief = goatclawRoleBrief("domain-manager", "Ship H4.");
    expect(brief.startsWith(goatclawRoleTemplate("domain-manager").preamble)).toBe(true);
    const lane = brief.indexOf(GOATCLAW_LANE_DEFAULTS);
    expect(lane).toBeGreaterThan(0);
    expect(brief.indexOf(GOATCLAW_REPORT_PROTOCOL)).toBeGreaterThan(lane);
    for (const kind of ["progress", "needs_input", "completed or failed"])
      expect(brief).toContain("- " + kind + ":");
    expect(brief).toContain("NOT RUN:");
    expect(brief).toContain("goat_decision_request");
    expect(brief.endsWith("Task:\n\nShip H4.")).toBe(true);
  });
});
