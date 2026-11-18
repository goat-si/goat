import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@goat/contracts";
import { CHATGPT_USAGE_URL } from "@goat/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

const checkedAt = "2026-10-25T16:00:00.000Z";

function managedChatGpt(instanceId: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
      externalUsage: { label: "ChatGPT usage", url: CHATGPT_USAGE_URL },
    },
  };
}

describe("UsageLimitsPooled ChatGPT usage card", () => {
  it("names the managed connections it covers", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              managedChatGpt("chatgpt_work", "ChatGPT Work"),
              managedChatGpt("chatgpt_personal", "ChatGPT Personal"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(screen.getByText("ChatGPT Work on Desk, ChatGPT Personal on Desk"))
      .toBeVisible();
    await expect
      .element(screen.getByText("View usage in ChatGPT with your connected account."))
      .toBeVisible();
  });
});

it("shows the monthly zero cap even when there is no monthly window", async () => {
  const claude = {
    ...managedChatGpt("claude", "Claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
    usageLimits: { checkedAt, windows: [], zeroSpendCap: true },
  };
  const presentations = new Map([
    [
      EnvironmentId.make("desk"),
      { entry: { target: { label: "Desk" } }, serverConfig: { providers: [claude] } },
    ],
  ]);
  await using screen = await render(
    <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
  );
  await expect.element(screen.getByText("Monthly spend: $0 cap")).toBeVisible();
});

it("presents a duplicate Cursor total as general usage", async () => {
  const cursor: ServerProvider = {
    ...managedChatGpt("cursor", "Cursor"),
    driver: ProviderDriverKind.make("cursor"),
    usageLimits: {
      checkedAt,
      windows: ["totalPercentUsed", "autoPercentUsed"].map((id) => ({
        id,
        kind: "monthly" as const,
        label: id === "autoPercentUsed" ? "Cursor Models" : "Overall",
        usedPercent: 14,
      })),
    },
  };
  const presentations = new Map([
    [
      EnvironmentId.make("desk"),
      {
        entry: { target: { label: "Desk" } },
        serverConfig: { providers: [cursor] },
      },
    ],
  ]);
  await using screen = await render(
    <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
  );
  await expect
    .element(screen.getByRole("columnheader", { name: /Usage\s*86% left/ }))
    .toBeVisible();
  await expect.element(screen.getByText("Cursor Models")).not.toBeInTheDocument();
});
