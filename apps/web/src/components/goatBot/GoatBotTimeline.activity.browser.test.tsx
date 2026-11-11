import type {
  GoatBotActivityLine,
  GoatBotActivityPlacement,
  GoatBotActivityStep,
  GoatBotRow,
} from "@goat/client-runtime/goatBot";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import "../../index.css";

// The timeline renders Markdown through ChatMarkdown, which reads other settings exports.
vi.mock("~/hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useSettings")>()),
  usePrimarySettings: () => "system",
}));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => null }));

import { GoatBotStepsContext } from "./GoatBotStepsLine";
import { GoatBotTimeline } from "./GoatBotTimeline";

const rows: ReadonlyArray<GoatBotRow> = Array.from({ length: 30 }, (_, index) => ({
  kind: "user",
  sendKey: null,
  requestKey: null,
  id: "message-" + index,
  text: "Message " + index,
  createdAt: "2026-11-12T03:00:00Z",
  firstInGroup: true,
  groupPosition: "single",
  delivery: { state: "delivered" },
  showReceipt: false,
}));

const step = (id: string, state: GoatBotActivityStep["state"] = "done"): GoatBotActivityStep => ({
  id,
  at: "2026-11-12T03:00:00Z",
  label: "Ran vp test " + id,
  state,
  entry: { id, createdAt: "2026-11-12T03:00:00Z", label: "Ran command", tone: "tool" },
});

const line = (steps: ReadonlyArray<GoatBotActivityStep>, summary: string): GoatBotActivityLine => ({
  key: "activity:" + (steps[0]?.id ?? "none"),
  summary,
  failedCount: steps.filter((entry) => entry.state === "failed").length,
  live: false,
  steps,
  earlier: 0,
});

const before = (rowId: string, value: GoatBotActivityLine): GoatBotActivityPlacement => ({
  beforeRow: new Map([[rowId, { kind: "steps", line: value }]]),
  trailing: null,
});
const trailing = (value: GoatBotActivityLine): GoatBotActivityPlacement => ({
  beforeRow: new Map(),
  trailing: { kind: "steps", line: value },
});

const scroller = (container: HTMLElement) => {
  const element = container.querySelector<HTMLElement>(".goat-timeline > div");
  if (element === null) throw new Error("expected the timeline scroller");
  return element;
};
const distanceFromBottom = (element: HTMLElement) =>
  element.scrollHeight - element.scrollTop - element.clientHeight;

// Resolves on the list's next resize. Observers created later hear a resize after the timeline's
// own, so the timeline has already kept or followed its place by then.
async function nextResize(container: HTMLElement) {
  const list = container.querySelector("ol");
  if (list === null) throw new Error("expected the conversation list");
  let calls = 0;
  let observed = () => {};
  let grew = () => {};
  const initial = new Promise<void>((resolve) => (observed = resolve));
  const resized = new Promise<void>((resolve) => (grew = resolve));
  const observer = new ResizeObserver(() => {
    calls += 1;
    if (calls === 1) return observed();
    observer.disconnect();
    grew();
  });
  observer.observe(list);
  await initial;
  return { resized };
}

function hostElement() {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;flex-direction:column;height:400px;width:360px";
  document.body.append(host);
  return host;
}

function Timeline({ placement }: { readonly placement: GoatBotActivityPlacement }) {
  return (
    <GoatBotStepsContext value={placement}>
      <GoatBotTimeline rows={rows} onRetry={() => {}} />
    </GoatBotStepsContext>
  );
}

it("opens a collapsed line in place without moving the conversation and says which step failed", async () => {
  const host = hostElement();
  const placement = before("message-29", line([step("a"), step("b", "failed")], "Ran 2 commands"));
  await using screen = await render(<Timeline placement={placement} />, {
    container: host,
    router: false, // The timeline renders no links that need a router.
  });
  const element = scroller(screen.container);
  await vi.waitFor(() => expect(distanceFromBottom(element)).toBeLessThanOrEqual(1));
  const button = screen.getByRole("button", { name: "Ran 2 commands · 1 failed" });
  await expect.element(button).toHaveAttribute("aria-expanded", "false");
  const top = element.scrollTop;
  const { resized } = await nextResize(screen.container);
  await button.click();
  await expect.element(button).toHaveAttribute("aria-expanded", "true");
  await resized;
  await expect.element(screen.getByText("Ran vp test b · failed", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Ran vp test a")).toBeVisible();
  expect(element.scrollTop).toBe(top);
  host.remove();
});

it("keeps an open trailing line pinned while it grows, and leaves a reader who scrolled up in place", async () => {
  const host = hostElement();
  const first = [step("a")];
  await using screen = await render(
    <Timeline placement={trailing(line(first, "Ran 1 command"))} />,
    {
      container: host,
      router: false, // The timeline renders no links that need a router.
    },
  );
  const element = scroller(screen.container);
  await vi.waitFor(() => expect(distanceFromBottom(element)).toBeLessThanOrEqual(1));
  // Opening keeps the reader's place; the steps that arrive next are followed.
  await screen.getByRole("button", { name: "Ran 1 command" }).click();

  const grown = [...first, ...["b", "c", "d", "e", "f"].map((id) => step(id))];
  await screen.rerender(<Timeline placement={trailing(line(grown, "Ran 6 commands"))} />);
  await expect.element(screen.getByText("Ran vp test f")).toBeInTheDocument();
  await vi.waitFor(() => expect(distanceFromBottom(element)).toBeLessThanOrEqual(1));

  element.scrollTop = 0;
  element.dispatchEvent(new Event("scroll"));
  const more = [...grown, ...["g", "h", "i"].map((id) => step(id))];
  const { resized } = await nextResize(screen.container);
  await screen.rerender(<Timeline placement={trailing(line(more, "Ran 9 commands"))} />);
  await expect.element(screen.getByText("Ran vp test i")).toBeInTheDocument();
  await resized;
  expect(element.scrollTop).toBe(0);
  host.remove();
});
