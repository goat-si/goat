import {
  ComposerContextId,
  type ComposerContextRecord,
  ComputerUseRefusalDetail,
  ComputerUseRefusalReason,
  computerUseRefusalReason,
} from "@goat/contracts";
import { formatComposerContextReference } from "@goat/shared/composerContextReferences";
import { CUA_DRIVER_EXCLUDED_TOOLS } from "@goat/shared/cuaDriverManifest";
import { describe, expect, it } from "vite-plus/test";

import { GOAT_DEVELOPMENT_INSTRUCTIONS } from "../developmentInstructions.ts";
import { buildRuntimeInstructions } from "../runtimeInstructions.ts";
import { COMPUTER_USE_PLATFORM_NOTES } from "./computerUse.ts";
import {
  builtInSkillSections,
  namedBuiltInSkills,
  resolveBuiltInSkills,
  withBuiltInSkillText,
} from "./registry.ts";

/**
 * Identifiers that exist only in other vendors' computer use skills and tool surfaces (#1161,
 * #1230). GOAT's skill is written for GOAT's own tools; any of these in it means vendor text
 * leaked in. Identifiers only, never copied prose.
 */
const VENDOR_ONLY_IDENTIFIERS = [
  "sky",
  "get_app_state",
  "perform_secondary_action",
  "select_text",
  "cua_repl",
  "js_reset",
  "turn_ended",
  "unified-computer-use",
  "computer-history",
  "openai-bundled",
  "aside-daemon",
  "AtYourSide",
  "Aside Computer Use",
  "runtime-computer-use",
];

const PLATFORMS = ["darwin", "win32", "linux", "freebsd"] as const;

describe("built-in skill activation", () => {
  it("loads the computer use skill only on turns with computer use attached", () => {
    expect(resolveBuiltInSkills({ attached: ["computer-use"] }).active).toEqual(["computer-use"]);
    expect(resolveBuiltInSkills({ attached: [] }).active).toEqual([]);
    expect(resolveBuiltInSkills({ attached: ["browser"] }).active).toEqual([]);
  });

  it("keeps a skill switched off in Settings off unless this turn requests its capability", () => {
    expect(
      resolveBuiltInSkills({ attached: ["computer-use"], disabled: ["computer-use"] }).active,
    ).toEqual([]);
    expect(
      resolveBuiltInSkills({
        attached: ["computer-use"],
        requested: ["computer-use"],
        disabled: ["computer-use"],
      }).active,
    ).toEqual(["computer-use"]);
  });

  it("reports a requested capability that is not attached instead of dropping it", () => {
    expect(resolveBuiltInSkills({ attached: [], requested: ["computer-use", "browser"] })).toEqual({
      active: [],
      unattached: ["computer-use", "browser"],
    });
  });
});

describe("computer use skill text", () => {
  it("continues through human input while preserving takeover and private-field stops", () => {
    const guidance = builtInSkillSections(["computer-use"], "darwin").join("\n");
    expect(guidance).toContain("Keep working while the person uses their keyboard or pointer");
    expect(guidance).toContain("An explicit takeover pause says `userIntervened`");
    expect(guidance).toContain("password, one-time code, payment and passkey fields are private");
    expect(guidance).not.toContain("the person's own keyboard or pointer where GOAT can detect it");
  });

  it("fits every section into one Codex context entry on every host", () => {
    for (const platform of PLATFORMS)
      for (const section of builtInSkillSections(["computer-use"], platform))
        expect(new TextEncoder().encode(section).byteLength).toBeLessThanOrEqual(4_000);
  });

  it("carries only the notes for the host it controls", () => {
    const mac = builtInSkillSections(["computer-use"], "darwin").join("\n");
    expect(mac).toContain('os="macOS"');
    expect(mac).not.toContain('os="Windows"');
    expect(builtInSkillSections(["computer-use"], "freebsd")).toHaveLength(2);
  });

  it("contains no identifier from another vendor's computer use skill", () => {
    const text = [
      ...builtInSkillSections(["computer-use"], "darwin"),
      ...Object.values(COMPUTER_USE_PLATFORM_NOTES),
    ].join("\n");
    for (const identifier of VENDOR_ONLY_IDENTIFIERS)
      // Identifiers hold only letters, digits, `_`, `-` and spaces, so they need no escaping.
      expect(text, identifier).not.toMatch(new RegExp(`(^|[^\\w-])${identifier}([^\\w-]|$)`, "i"));
  });

  it("is in the runtime instructions exactly when the turn has computer use", () => {
    expect(buildRuntimeInstructions({ harness: "Codex", computerUse: true })).toContain(
      "<computer_use>",
    );
    expect(buildRuntimeInstructions({ harness: "Codex", computerUse: false })).not.toContain(
      "<computer_use>",
    );
  });
});

describe("computer use skill against what agents receive today", () => {
  // Agents reach the raw `cua-driver` tools through GOAT's lease proxy. The proxy answers with
  // the reasons computerUseRefusalReason maps its details to; the helper protocol's other
  // refusals are not on that path yet, so naming them would teach recovery no result triggers.
  const codeSpans = [
    ...builtInSkillSections(["computer-use"], "darwin"),
    ...Object.values(COMPUTER_USE_PLATFORM_NOTES),
  ]
    .join("\n")
    .matchAll(/`([^`]+)`/g)
    .map((match) => match[1] ?? "")
    .toArray();

  const proxyReasons = new Set<string>(
    ComputerUseRefusalDetail.literals.map((detail) => computerUseRefusalReason(detail)),
  );
  const guidance = [
    ...builtInSkillSections(["computer-use"], "darwin"),
    ...Object.values(COMPUTER_USE_PLATFORM_NOTES),
  ].join("\n");

  it("names no helper-protocol refusal the proxy path does not return", () => {
    const helperOnly = new Set<string>(
      ComputerUseRefusalReason.literals.filter((reason) => !proxyReasons.has(reason)),
    );
    expect(codeSpans.filter((span) => helperOnly.has(span))).toEqual([]);
  });

  it("names every refusal reason the proxy can answer with, so none reads as an unknown error", () => {
    for (const reason of proxyReasons) expect(codeSpans, reason).toContain(reason);
  });

  it("tells agents a cut-off call may have acted, unlike a refusal", () => {
    // The proxy answers a call a pause or Stop cut off after it reached the driver with
    // code "interrupted"; with effect "unverifiable" the input may have landed.
    const line = guidance.split("\n").find((entry) => entry.includes('code: "interrupted"'));
    expect(line).toBeDefined();
    expect(line).toContain('effect: "unverifiable"');
    expect(line).toContain("may have acted");
  });

  it("teaches diff reads, narrow reads and element tokens from the newest read only", () => {
    for (const argument of [
      'since: "latest"',
      "query",
      "max_elements",
      "max_depth",
      "element_token",
      // A screenshot-only read keeps the snapshot's tokens; a tree read retires them.
      "include_accessibility_tree: false",
    ])
      expect(codeSpans, argument).toContain(argument);
  });

  it("waits with verify_state for a closed window but never for an element to disappear", () => {
    // The driver refuses element exists:false (an incomplete walk cannot prove absence) and
    // accepts window exists:false.
    const line = guidance.split("\n").find((entry) => entry.includes("`verify_state`")) ?? "";
    expect(line).toMatch(/element[^.]*disappear/);
    expect(line).toMatch(/window[^.]*gone/);
  });

  it("warns that a newline or tab in typed text presses a key", () => {
    // The driver types a newline as Return and a tab as Tab; a draft can be sent by accident.
    const line = guidance.split("\n").find((entry) => entry.startsWith("- `type_text`")) ?? "";
    expect(line).toMatch(/newline[^.]*Return/);
    expect(line).toMatch(/tab[^.]*Tab/);
  });

  it("tells agents what to do when another thread holds the window or the turn has ended", () => {
    // The proxy refuses a call another thread's reservation covers (target_busy) and a call after
    // the thread's turn ended (control_idle); neither reached a driver, and each wants a different
    // next step than a refusal about approvals.
    for (const detail of ["target_busy", "control_idle"])
      expect(
        guidance.split("\n").find((entry) => entry.includes(`\`${detail}\``)),
        detail,
      ).toBeDefined();
  });

  it("teaches no tool an approved-app turn refuses", () => {
    // ComputerUseScope refuses scripts and batches whenever a thread's control names apps.
    for (const tool of ["run_steps", "run_script"]) expect(codeSpans).not.toContain(tool);
  });

  it("reports an action as done only after a read showed its effect (#1599)", () => {
    // An agent that calls an unconfirmed send or purchase done misleads the person about what
    // happened on their screen; the skill makes it say the effect is unconfirmed instead.
    const finish = builtInSkillSections(["computer-use"], "darwin").join("\n");
    expect(finish).toContain("Call an action done only when a later read showed its effect.");
    expect(finish).toContain("say you could not confirm whether it happened");
  });

  it("treats input as unsent only for an explicit refusal or a pre-send code without an effect", () => {
    // delivery_failed can follow a key that already went down, and background_unavailable can
    // come with an unverifiable or partial effect; resending either could submit twice.
    const results = builtInSkillSections(["computer-use"], "linux")[0] ?? "";
    const line = (code: string) =>
      results.split("\n").find((entry) => entry.includes(`\`${code}\``));
    expect(line("stale_element_token")).toContain("Nothing was sent");
    expect(line("stale_element_token")).toContain("always outranks");
    expect(line("unverifiable")).toContain("may have landed");
    expect(line("partial")).toContain("may have landed");
    expect(line("background_unavailable")).toBeUndefined();
    expect(COMPUTER_USE_PLATFORM_NOTES.linux).toMatch(/`background_unavailable`, observe first/);
  });

  it("names no driver tool GOAT withholds from agents", () => {
    expect(codeSpans.filter((span) => Object.hasOwn(CUA_DRIVER_EXCLUDED_TOOLS, span))).toEqual([]);
  });

  it("teaches full-access foreground authority and same-turn approval without self-restoring", () => {
    const line = guidance.split("\n").find((entry) => entry.includes("`bring_to_front`")) ?? "";
    expect(line).toContain("`computer_use.request` with `foreground: true` and no `apps`");
    expect(line).toContain(
      "Full-access turns a person directs already have foreground authority without asking",
    );
    expect(line).toContain("unattended full-access work still needs foreground approval");
    expect(line).toContain("it waits for the answer in this turn");
    expect(line).toMatch(/Pause, Stop or the end of the turn revokes it/);
    expect(line).toContain("full-access foreground returns automatically only next turn");
    expect(guidance).not.toContain("ask them first");
    expect(guidance).toContain("Never restore focus yourself.");
  });
});

describe("the goat-discipline skill loads only when a message names it", () => {
  const named = namedBuiltInSkills;
  const terminal: ComposerContextRecord = {
    version: 1,
    kind: "terminal",
    contextId: ComposerContextId.make("term_1"),
    label: "Build $goat-discipline output",
    terminalId: "default",
    terminalLabel: "Terminal 1",
    lineStart: 1,
    lineEnd: 1,
    text: "$goat-discipline",
  };
  const reference = formatComposerContextReference(terminal);

  it("activates on an authored mention with any currency sigil", () => {
    expect(named("Fix the bug $goat-discipline")).toEqual(["goat-discipline"]);
    expect(named("€goat-discipline then plan")).toEqual(["goat-discipline"]);
    expect(named("Fix the bug")).toEqual([]);
    expect(named("$computer-use please")).toEqual([]);
  });

  it("ignores the name inside an attachment's label or content", () => {
    expect(named(`Inspect ${reference}`)).toEqual([]);
    expect(named(`Inspect ${reference} $goat-discipline`)).toEqual(["goat-discipline"]);
  });

  it("activates nothing from a legacy context message, whose authored text cannot be separated", () => {
    const legacy =
      "Inspect this\n\n<terminal_context>\n- Terminal 1 line 1:\n  1 | $goat-discipline\n</terminal_context>";
    expect(named(legacy)).toEqual([]);
    expect(named(`<review_comment> ${reference}`)).toEqual([]);
    const oddLabel = { ...terminal, label: "<review_comment> notes" };
    expect(named(`${formatComposerContextReference(oddLabel)} $goat-discipline`)).toEqual([
      "goat-discipline",
    ]);
  });

  it("lets a project or environment switch beat a mention, and leaves capability skills alone", () => {
    expect(resolveBuiltInSkills({ attached: [], named: ["goat-discipline"] }).active).toEqual([
      "goat-discipline",
    ]);
    expect(
      resolveBuiltInSkills({
        attached: [],
        named: ["goat-discipline"],
        disabled: ["goat-discipline"],
      }).active,
    ).toEqual([]);
    expect(resolveBuiltInSkills({ attached: ["computer-use"] }).active).toEqual(["computer-use"]);
  });

  it("puts the skill before the request once, and never in front of a native command", () => {
    const text = withBuiltInSkillText("Plan the change $goat-discipline", ["goat-discipline"]);
    expect(text.startsWith('<goat_skill name="goat-discipline">')).toBe(true);
    expect(text.endsWith("Plan the change $goat-discipline")).toBe(true);
    expect(text.split("<goat_skill").length - 1).toBe(1);
    expect(withBuiltInSkillText("  /review $goat-discipline", ["goat-discipline"])).toBe(
      "  /review $goat-discipline",
    );
    expect(withBuiltInSkillText("Plan", [])).toBe("Plan");
  });

  it("keeps the long guidance out of the always-injected contract", () => {
    const skill = builtInSkillSections(["goat-discipline"]).join("\n");
    expect(skill).toContain("C4");
    expect(skill).toContain("Briefing a lane");
    expect(skill).not.toMatch(/\p{Sc}[a-zA-Z]/u);
    expect(GOAT_DEVELOPMENT_INSTRUCTIONS).not.toContain("C4");
    expect(GOAT_DEVELOPMENT_INSTRUCTIONS).toContain("NOT RUN:");
    expect(GOAT_DEVELOPMENT_INSTRUCTIONS).toContain("goat-discipline");
    expect(Buffer.byteLength(GOAT_DEVELOPMENT_INSTRUCTIONS)).toBeLessThan(1_100);
  });
});
