import {
  BotThreadRow,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
  type SlackChannelSettings,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  diagnoseGoatBot,
  goatBotModelStatus,
  type GoatBotDiagnosticsInput,
  type GoatBotModelStatus,
} from "./diagnostics.ts";

const HOME = EnvironmentId.make("env-studio");
const LAPTOP = EnvironmentId.make("env-laptop");
const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const decodeRow = Schema.decodeUnknownSync(BotThreadRow);

const task = (id: string, status: string, updatedAt = "2026-11-07T10:00:00.000Z") =>
  decodeRow({
    kind: "task",
    task: { taskId: id, title: "Task " + id, status, updatedAt },
    view: { taskId: id, doneAt: null, pinnedAt: null, readThrough: null },
    lastActivityAt: updatedAt,
    unread: false,
    mainMessagesSinceQuiet: 0,
  });

const model: GoatBotModelStatus = {
  model: "GPT-5.4",
  provider: "Codex",
  available: true,
  inherited: false,
};

const slack = (patch: Partial<SlackChannelSettings>) =>
  ({ enabled: true, status: "connected", ...patch }) as const;

function healthy(patch: Partial<GoatBotDiagnosticsInput> = {}): GoatBotDiagnosticsInput {
  return {
    home: {
      state: "claimed",
      claim: { environmentId: HOME, claimedAt: 1, claimId: "claim" },
      homeKnown: true,
      homeConnected: true,
      homeSupportsBot: true,
      staleTargetIds: [],
    },
    homeLabel: "Mac Studio",
    moveTarget: null,
    member: false,
    model,
    canChangeModel: true,
    rows: [],
    slack: null,
    canConfigureSlack: true,
    now: NOW,
    ...patch,
  };
}

const line = (input: GoatBotDiagnosticsInput, key: string) =>
  diagnoseGoatBot(input).lines.find((entry) => entry.key === key);

describe("diagnoseGoatBot", () => {
  it("says Ready with no actions when home, model and work are fine", () => {
    const result = diagnoseGoatBot(healthy());
    expect(result.verdict).toBe("ready");
    expect(result.title).toBe("Ready");
    expect(result.lines.map((entry) => [entry.key, entry.text])).toEqual([
      ["home", "Answers on Mac Studio"],
      ["model", "GPT-5.4 on Codex"],
      ["work", "No open work"],
    ]);
    expect(result.lines.every((entry) => entry.action === null)).toBe(true);
  });

  it("reports an offline home and offers the claim only where the viewer may write", () => {
    const offline = healthy({
      home: { ...healthy().home, homeConnected: false } as GoatBotDiagnosticsInput["home"],
      moveTarget: { environmentId: LAPTOP, label: "MacBook" },
    });
    const result = diagnoseGoatBot(offline);
    expect(result.verdict).toBe("down");
    expect(line(offline, "home")).toMatchObject({
      tone: "error",
      text: "Home machine is offline (Mac Studio)",
      action: { kind: "claim_home", environmentId: LAPTOP, label: "Make MacBook the home" },
    });
    expect(line({ ...offline, moveTarget: null }, "home")?.action).toBeNull();
  });

  it("never says Ready while the home or the model is still unknown", () => {
    expect(diagnoseGoatBot(healthy({ home: { state: "unknown" } }))).toMatchObject({
      verdict: "checking",
    });
    const noModel = healthy({ model: null });
    expect(diagnoseGoatBot(noModel).verdict).toBe("checking");
    expect(line(noModel, "model")).toMatchObject({ tone: "pending", action: null });
    expect(line(healthy({ home: { state: "unclaimed" } }), "home")?.tone).toBe("pending");
  });

  it("offers another model for the main bot only with permission", () => {
    const broken = healthy({ model: { ...model, available: false } });
    expect(diagnoseGoatBot(broken).verdict).toBe("down");
    expect(line(broken, "model")).toMatchObject({
      tone: "error",
      text: "Model unavailable: GPT-5.4",
      action: { kind: "choose_model", environmentId: HOME },
    });
    expect(line({ ...broken, canChangeModel: false }, "model")?.action).toBeNull();
  });

  it("judges a member by its own model and fixes an inherited one through the main setting", () => {
    const own = healthy({ member: true, model: { ...model, available: false } });
    expect(line(own, "model")).toMatchObject({ tone: "error", action: null });
    const inherited = healthy({ member: true, model: { ...model, inherited: true } });
    expect(line(inherited, "model")?.text).toBe("Uses GOAT Bot's current model (GPT-5.4 on Codex)");
    const inheritedBroken = healthy({
      member: true,
      model: { ...model, inherited: true, available: false },
    });
    expect(line(inheritedBroken, "model")?.action?.kind).toBe("choose_model");
  });

  it("counts running, starting or queued, and waiting work from the rows", () => {
    const input = healthy({
      rows: [
        task("a", "running"),
        task("b", "received"),
        task("c", "dispatching"),
        task("d", "waiting_input", "2026-11-07T11:00:00.000Z"),
        task("e", "waiting_input", "2026-11-07T09:00:00.000Z"),
        task("f", "completed"),
      ],
    });
    expect(line(input, "work")).toMatchObject({
      tone: "warn",
      text: "1 running · 2 starting or queued · 2 waiting for your answer",
      action: { kind: "open_task", taskId: "e" },
    });
    expect(diagnoseGoatBot(input).verdict).toBe("attention");
  });

  it("calls the counts a lower bound only when the server returned a full page", () => {
    const rows = (count: number) =>
      Array.from({ length: count }, (_, index) => task(String(index), "running"));
    expect(line(healthy({ rows: rows(100) }), "work")?.text).toBe("At least 100 running");
    expect(line(healthy({ rows: rows(99) }), "work")?.text).toBe("99 running");
  });

  it("waits for the rows before saying anything about work", () => {
    const loading = healthy({ rows: null });
    expect(line(loading, "work")).toMatchObject({ tone: "pending", text: "Loading work…" });
    expect(diagnoseGoatBot(loading).verdict).toBe("checking");
    expect(line(healthy({ rows: "unavailable" }), "work")).toBeUndefined();
  });

  it("shows Slack problems for the main bot and hides Slack for members or when off", () => {
    const failing = healthy({ slack: [slack({ status: "error", lastError: "invalid_auth" })] });
    expect(line(failing, "slack")).toMatchObject({
      tone: "error",
      text: "Slack: invalid_auth",
      action: { kind: "open_slack_settings", environmentId: HOME },
    });
    expect(line({ ...failing, canConfigureSlack: false }, "slack")?.action).toBeNull();
    expect(line({ ...failing, member: true }, "slack")).toBeUndefined();
    expect(line(healthy({ slack: [slack({ enabled: false })] }), "slack")).toBeUndefined();
    expect(line(healthy({ slack: [slack({})] }), "slack")).toMatchObject({
      tone: "ok",
      text: "Slack connected",
      action: null,
    });
  });

  it("warns about a Slack reply that failed in the last day and forgets older ones", () => {
    const failedAt = (at: string) =>
      healthy({
        slack: [slack({ lastDeliveryError: { code: "rate_limited", at } as never })],
      });
    expect(line(failedAt("2026-11-07T08:00:00.000Z"), "slack")).toMatchObject({
      tone: "warn",
      text: "Last Slack reply failed (rate_limited)",
    });
    expect(line(failedAt("2026-11-05T08:00:00.000Z"), "slack")?.tone).toBe("ok");
  });
});

function provider(input: {
  instanceId: string;
  status?: ServerProvider["status"];
  models: ReadonlyArray<string>;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: input.status ?? "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models.map((slug, index) => ({
      slug,
      name: slug.toUpperCase(),
      isCustom: false,
      ...(index === 0 ? { isDefault: true } : {}),
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
  };
}

describe("goatBotModelStatus", () => {
  const settings: ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    goatBotModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  };

  it("reads the main bot's model from its settings and the ready providers", () => {
    expect(
      goatBotModelStatus({
        settings,
        providers: [provider({ instanceId: "codex", models: ["gpt-5.4"] })],
      }),
    ).toEqual({ model: "GPT-5.4", provider: "Codex", available: true, inherited: false });
    expect(
      goatBotModelStatus({
        settings,
        providers: [provider({ instanceId: "codex", status: "error", models: ["gpt-5.4"] })],
      }).available,
    ).toBe(false);
  });

  it("judges a member's own model by its selection and marks a missing one inherited", () => {
    const providers = [provider({ instanceId: "codex", models: ["gpt-5.4", "gpt-5.5"] })];
    expect(
      goatBotModelStatus({
        settings,
        providers,
        override: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-9" },
      }),
    ).toEqual({ model: "gpt-9", provider: "Codex", available: false, inherited: false });
    expect(goatBotModelStatus({ settings, providers, override: null })).toEqual({
      model: "GPT-5.4",
      provider: "Codex",
      available: true,
      inherited: true,
    });
  });
});
