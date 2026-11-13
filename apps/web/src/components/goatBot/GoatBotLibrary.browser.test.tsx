import { ChannelGatewayError, EnvironmentAuthorizationError, EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  supported: true,
  phase: "connected",
  data: null as unknown,
  failure: null as unknown,
  refresh: vi.fn(),
  requested: vi.fn(),
}));
vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: state.phase } }),
}));
vi.mock("~/state/entities", () => ({
  useServerConfigs: () =>
    new Map([["env", { environment: { capabilities: { goatBotLibrary: state.supported } } }]]),
}));
vi.mock("~/state/channels", () => ({
  channelEnvironment: {
    listBotArtifacts: (target: unknown) => {
      state.requested(target);
      return "artifacts";
    },
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom === null ? null : state.data,
    failure: atom === null ? null : state.failure,
    error: state.failure === null ? null : "failed",
    isPending: false,
    isSuccess: state.data !== null,
    refresh: state.refresh,
  }),
}));
import { GoatBotLibrary } from "./GoatBotLibrary";

const environmentId = EnvironmentId.make("env");
const listing = (names: string[], truncated = false) => ({
  artifacts: names.map((relativePath, index) => ({
    relativePath,
    size: 1536,
    modifiedAt: `2026-11-0${7 - index}T10:00:00.000Z`,
  })),
  truncated,
});
function setup(options: { data?: unknown; failure?: unknown; supported?: boolean } = {}) {
  state.phase = "connected";
  state.supported = options.supported ?? true;
  state.data =
    options.data === undefined
      ? listing(["notes/report.txt", "chart.png", "deck.pdf"])
      : options.data;
  state.failure = options.failure ?? null;
  state.refresh.mockReset();
  state.requested.mockReset();
}

it("an older server is not asked for files", async () => {
  setup({ supported: false });
  await using screen = await render(
    <GoatBotLibrary environmentId={environmentId} onOpen={() => {}} />,
  );
  await expect.element(screen.getByText("Files need a newer GOAT server.")).toBeVisible();
  expect(state.requested).not.toHaveBeenCalled();
});

it("says when GOAT Bot has saved nothing yet", async () => {
  setup({ data: listing([]) });
  await using screen = await render(
    <GoatBotLibrary environmentId={environmentId} onOpen={() => {}} />,
  );
  await expect.element(screen.getByText("No files yet")).toBeVisible();
});

it("lists files newest first under their day with folder and size, and says when the list is cut short", async () => {
  setup({ data: listing(["notes/report.txt", "chart.png"], true) });
  await using screen = await render(
    <GoatBotLibrary environmentId={environmentId} onOpen={() => {}} />,
  );
  const days = [...screen.container.querySelectorAll("section")].map((day) =>
    day.getAttribute("aria-label"),
  );
  expect(days).toHaveLength(2);
  const rows = [...screen.container.querySelectorAll("li")].map((row) => row.textContent ?? "");
  expect(rows[0]).toContain("report.txt");
  expect(rows[0]).toContain("notes");
  expect(rows[0]).toContain("1.5 KB");
  expect(rows[1]).toContain("chart.png");
  await expect.element(screen.getByText("Showing the newest files only.")).toBeVisible();
  expect(state.refresh).toHaveBeenCalledTimes(1);
});

it.each([
  {
    name: "missing filesystem read",
    failure: new EnvironmentAuthorizationError({ message: "no", requiredScope: "filesystem:read" }),
    copy: "This device can't read GOAT Bot's files.",
    retry: false,
  },
  {
    name: "not GOAT Bot's home",
    failure: new ChannelGatewayError({ reason: "not_home" }),
    copy: "GOAT Bot's files are on its home computer.",
    retry: false,
  },
  {
    name: "other failure",
    failure: new Error("socket"),
    copy: "Couldn't load GOAT Bot's files.",
    retry: true,
  },
])("shows why files cannot load: $name", async ({ failure, copy, retry }) => {
  setup({ data: null, failure });
  await using screen = await render(
    <GoatBotLibrary environmentId={environmentId} onOpen={() => {}} />,
  );
  await expect.element(screen.getByText(copy)).toBeVisible();
  const again = screen.getByRole("button", { name: "Try again" });
  if (!retry) {
    expect(again.query()).toBeNull();
    return;
  }
  state.refresh.mockClear();
  await userEvent.click(again);
  expect(state.refresh).toHaveBeenCalledTimes(1);
});

it("a row asks the chat to open its file and marks the open one", async () => {
  setup();
  const onOpen = vi.fn();
  await using screen = await render(
    <GoatBotLibrary environmentId={environmentId} openPath="chart.png" onOpen={onOpen} />,
  );
  await userEvent.click(screen.getByRole("button", { name: /report\.txt/ }));
  expect(onOpen).toHaveBeenCalledWith(
    expect.objectContaining({ relativePath: "notes/report.txt" }),
  );
  await expect
    .element(screen.getByRole("button", { name: /chart\.png/ }))
    .toHaveAttribute("aria-current", "true");
});

it("explains when files are offline without offering retry", async () => {
  setup({ data: null, failure: new Error("socket") });
  state.phase = "offline";
  await using screen = await render(
    <GoatBotLibrary environmentId={environmentId} onOpen={() => {}} />,
  );
  await expect
    .element(screen.getByText("Files are unavailable while GOAT Bot's computer is offline."))
    .toBeVisible();
  expect(screen.getByRole("button", { name: "Try again" }).query()).toBeNull();
});
