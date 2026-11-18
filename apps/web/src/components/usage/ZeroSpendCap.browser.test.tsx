import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { usageLimitsBannerItem } from "../chat/ComposerUsageLimits";
import { HostCard } from "../settings/HostsSettings";

const checkedAt = "2026-10-25T16:00:00.000Z";
const limits = { checkedAt, windows: [], zeroSpendCap: true };
const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claude");

it("shows the zero cap in the composer with no windows", async () => {
  const item = usageLimitsBannerItem(
    "usage",
    {
      createdAt: checkedAt,
      accounts: [{ id: "claude", driver, label: "Claude", instanceId, limits }],
      notices: [],
    },
    EnvironmentId.make("desk"),
    () => {},
  );
  await using screen = await render(<>{item.children}</>);
  await expect.element(screen.getByText("Monthly spend: $0 cap")).toBeVisible();
  expect(screen.container.textContent).not.toContain("No limits reported.");
});

it("shows the zero cap in host quota details with no windows", async () => {
  await using screen = await render(
    <HostCard
      kind="desktop"
      now={Date.parse(checkedAt)}
      card={{
        key: "desk",
        local: true,
        label: "Desk",
        platform: null,
        version: null,
        tone: "ok",
        status: "Reachable",
        message: null,
        meters: null,
        loadAverage: null,
        threads: null,
        computerUse: null,
        browser: null,
        omitted: null,
        quotas: [{ instanceId, driver, limits, fromCache: false }],
      }}
    />,
  );
  await expect.element(screen.getByText("Monthly spend: $0 cap")).toBeVisible();
  expect(screen.container.textContent).not.toContain("No limits reported.");
});
