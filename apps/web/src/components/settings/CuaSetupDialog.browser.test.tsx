import type { CuaHostStatus, DesktopCuaGrants, DesktopCuaVerification } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { CuaSetupDialog } from "./CuaSetupDialog";
import type { CuaPermission } from "./CuaSetupDialog.logic";

const mac: CuaHostStatus = { platform: "darwin", running: false };

const HELPER = {
  principal: "helper",
  name: "GOAT Computer Use",
  bundleId: "si.goat.desktop.computer-use",
  bundlePath: "/Applications/GOAT.app/Contents/Helpers/GOAT Computer Use.app",
} as const;

/** System Settings as seen through the helper: opening a pane grants it unless told otherwise. */
function fixture(options: { grantOnOpen?: boolean; unusable?: string } = {}) {
  const grants = { accessibility: false, screenRecording: false };
  // What the helper's next reads end as when it does not answer at all.
  const helper = { unanswered: undefined as DesktopCuaGrants | undefined };
  return {
    grants,
    helper,
    onCheck: vi.fn(
      async (): Promise<DesktopCuaGrants> =>
        helper.unanswered ??
        (options.unusable
          ? { principal: "unusable", message: options.unusable }
          : { ...HELPER, ...grants }),
    ),
    onAllow: vi.fn(async (permission: CuaPermission) => {
      if (options.grantOnOpen === false) return;
      grants[permission === "accessibility" ? "accessibility" : "screenRecording"] = true;
    }),
    onReveal: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onRelaunch: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onEnable: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
    onVerify: vi.fn<() => Promise<DesktopCuaVerification>>(),
    onClose: vi.fn<(outcome: "enabled" | "dismissed") => void>(),
  };
}

function dialog(
  f: ReturnType<typeof fixture>,
  props: { status?: CuaHostStatus; localMac?: boolean; localCheck?: boolean } = {},
) {
  return render(
    <CuaSetupDialog
      enabled={false}
      hostLabel="this Mac"
      status={props.status ?? mac}
      localMac={props.localMac ?? true}
      localCheck={props.localCheck ?? props.localMac ?? true}
      onCheck={f.onCheck}
      onAllow={f.onAllow}
      onReveal={f.onReveal}
      onRelaunch={f.onRelaunch}
      onEnable={f.onEnable}
      onVerify={f.onVerify}
      onClose={f.onClose}
    />,
    { router: false },
  );
}

// The dialog renders in a portal, so it is read from the document body.
const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
async function click(label: string) {
  const target = button(label);
  expect(target, label).toBeDefined();
  await act(() => target!.click());
}
const rows = () =>
  [...document.body.querySelectorAll('[aria-label="Permission check"] li')].map(
    (row) => row.textContent,
  );
// Returning from System Settings focuses GOAT, which rechecks the grants.
const refocus = () => act(() => window.dispatchEvent(new Event("focus")));
const text = () => document.body.textContent ?? "";
// Steps go one at a time: only the first missing grant can be opened.
async function allowAll() {
  for (const label of ["Open Settings", "Open Settings"]) {
    await click(label);
    await refocus();
  }
}

it("offers Input Monitoring as optional without blocking computer use", async () => {
  const f = fixture();
  await using _screen = await dialog(f);
  expect(text()).toContain("Input Monitoring (optional)");
  expect(text()).toContain("Lets you press Esc to stop the agent.");
  await allowAll();
  expect(button("Turn on")?.disabled).toBe(false);
});

it("turns on only after both grants, then reports the step that failed and retries the check", async () => {
  const f = fixture();
  f.onVerify.mockResolvedValueOnce({
    verified: false,
    steps: [
      { id: "grants", ok: true },
      { id: "restart", ok: true },
      { id: "agentRoute", ok: true },
      { id: "permissions", ok: true },
      { id: "identity", ok: true },
      {
        id: "capture",
        ok: false,
        detail: "The screen is locked. Unlock this Mac, then try again.",
      },
    ],
  });
  await using _screen = await dialog(f);
  expect(button("Turn on")?.disabled).toBe(true);
  await allowAll();
  expect(f.onAllow.mock.calls.map(([permission]) => permission)).toEqual([
    "accessibility",
    "screen-recording",
  ]);
  expect(button("Turn on")?.disabled).toBe(false);

  await click("Turn on");
  expect(f.onEnable).toHaveBeenCalledTimes(1);
  expect(f.onVerify).toHaveBeenCalledTimes(1);
  expect(rows()).toEqual([
    "Permissions allowed (passed)",
    "Computer use restarted with them (passed)",
    "Agents can start computer use (passed)",
    "Computer use sees both permissions (passed)",
    "Computer use runs as the allowed app (passed)",
    "Captured a GOAT window (failed)The screen is locked. Unlock this Mac, then try again.",
    "Read the window's controls (not checked)",
  ]);
  // The setting is already on, so a failed check offers Close, never Later.
  expect(button("Later")).toBeUndefined();

  f.onVerify.mockResolvedValueOnce({
    verified: true,
    steps: (
      [
        "grants",
        "restart",
        "agentRoute",
        "permissions",
        "identity",
        "capture",
        "accessibility",
      ] as const
    ).map((id) => ({ id, ok: true })),
  });
  await click("Try again");
  expect(f.onEnable).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("Computer use is ready");
  await click("Done");
  expect(f.onClose).toHaveBeenCalledWith("enabled");
});

it("asks for the helper's grants one step at a time and marks each one allowed", async () => {
  const f = fixture();
  const reason = "Accessibility and Screen Recording must be granted at this Mac.";
  await using _screen = await dialog(f, {
    status: { platform: "darwin", running: false, display: { capability: "partial", reason } },
  });
  await refocus();
  expect(text()).toContain("Agents work through GOAT Computer Use");
  // The host's generic note would repeat the steps.
  expect(text()).not.toContain(reason);
  expect(text()).toContain("Step 1 · Accessibility (to do now)");
  expect(text()).toContain("Step 2 · Screen & System Audio Recording (after the step above)");
  expect(button("Open Settings")).toBeDefined();
  expect(
    [...document.body.querySelectorAll("button")].filter(
      (node) => node.textContent === "Open Settings" && !node.disabled,
    ),
  ).toHaveLength(1);

  await click("Open Settings");
  await refocus();
  expect(text()).toContain("Step 1 · Accessibility (allowed)");
  expect(text()).toContain("Step 2 · Screen & System Audio Recording (to do now)");
  await click("Open Settings");
  await refocus();
  expect(text()).toContain("Screen & System Audio Recording (allowed)");
  expect(button("Turn on")?.disabled).toBe(false);
});

it("keeps waiting while another copy's switch is on, and says which copy GOAT checks without telling the person to remove the other app's row", async () => {
  const f = fixture({ grantOnOpen: false });
  await using _screen = await dialog(f);
  await refocus();
  await click("Open Settings");
  await refocus();
  expect(text()).toContain("Accessibility (waiting for you)");
  expect(text()).toContain("The row that is on may be for another copy");
  expect(text()).toContain("GOAT and GOAT Nightly each list their own GOAT Computer Use");
  expect(text()).not.toContain("belongs to an older copy");
  expect(text()).not.toContain("remove every");
  expect(button("Open again")).toBeDefined();
  expect(button("Turn on")?.disabled).toBe(true);
  // A helper is read fresh on every check, so waiting alone never calls for a restart.
  expect(button("Quit & reopen")).toBeUndefined();

  await click("Still not allowed?");
  expect(text()).toContain("tccutil reset Accessibility si.goat.desktop.computer-use");
  expect(text()).toContain("Only the switch for GOAT Computer Use counts.");
  expect(text()).not.toContain("select every");
  expect(text()).toContain("takes away that app's permission");
  expect(text()).toContain(`GOAT is checking the copy at ${HELPER.bundlePath}.`);
  expect(text()).toContain(`Its bundle ID is ${HELPER.bundleId}.`);
  await click("Show GOAT Computer Use in Finder");
  expect(f.onReveal).toHaveBeenCalledTimes(1);

  // The person drags the helper of the app in use into the list and turns it on.
  f.grants.accessibility = true;
  await refocus();
  expect(text()).toContain("Accessibility (allowed)");
});

it("says GOAT Computer Use did not answer after two failed reads, with Try again and no grant steps or Quit & reopen, and returns to the steps once it answers", async () => {
  const f = fixture({ grantOnOpen: false });
  await using _screen = await dialog(f);
  await refocus();
  await click("Open Settings");
  await refocus();
  expect(text()).toContain("Accessibility (waiting for you)");

  const message = "GOAT Computer Use did not answer: it took too long.";
  f.helper.unanswered = { principal: "unusable", message, unanswered: "tookTooLong" };
  await refocus();
  await refocus();
  expect(text()).toContain(message);
  expect(text()).toContain("it cannot tell whether one is missing");
  expect(text()).toContain("keeps asking");
  expect(text()).not.toContain("waiting for you");
  for (const label of ["Open Settings", "Open again", "Quit & reopen"])
    expect(button(label), label).toBeUndefined();
  expect(button("Turn on")?.disabled).toBe(true);

  const asked = f.onCheck.mock.calls.length;
  await click("Try again");
  expect(f.onCheck.mock.calls.length).toBeGreaterThan(asked);
  expect(text()).toContain(message);

  f.helper.unanswered = undefined;
  await refocus();
  expect(text()).toContain("Accessibility (waiting for you)");
  expect(text()).not.toContain(message);
});

it("stops showing a grant as waiting for its switch when reads keep failing, instead of retrying without a word", async () => {
  const f = fixture({ grantOnOpen: false });
  await using _screen = await dialog(f);
  await refocus();
  await click("Open Settings");
  await refocus();
  expect(text()).toContain("Accessibility (waiting for you)");

  // A desktop from before the reason rejects the read instead of answering it.
  f.onCheck.mockRejectedValue(new Error("Error invoking remote method"));
  await refocus();
  await refocus();
  expect(text()).toContain("GOAT could not check the permissions on this Mac.");
  expect(text()).not.toContain("waiting for you");
  expect(text()).not.toContain("We'll try again automatically");
  expect(button("Open again")).toBeUndefined();
  expect(button("Try again")).toBeDefined();
});

it("a Try again while a read is still out asks again, and shows that read's answer instead of the older one's", async () => {
  const f = fixture({ grantOnOpen: false });
  await using _screen = await dialog(f);
  await refocus();
  const message = "GOAT Computer Use did not answer: it took too long.";
  f.helper.unanswered = { principal: "unusable", message, unanswered: "tookTooLong" };
  await refocus();
  await refocus();
  expect(text()).toContain(message);

  const answers: Array<(grants: DesktopCuaGrants) => void> = [];
  const held = () => new Promise<DesktopCuaGrants>((resolve) => answers.push(resolve));
  f.onCheck.mockImplementationOnce(held);
  f.onCheck.mockImplementationOnce(held);
  await refocus();
  await click("Try again");
  expect(button("Asking…")?.disabled).toBe(true);
  expect(answers).toHaveLength(2);

  // The read that was already out answers late; the one the person asked for decides.
  await act(() => answers[0]?.({ ...HELPER, accessibility: true, screenRecording: true }));
  expect(text()).toContain(message);
  expect(button("Asking…")).toBeDefined();
  await act(() => answers[1]?.({ ...HELPER, ...f.grants }));
  expect(text()).not.toContain(message);
  expect(text()).toContain("Step 1 · Accessibility (to do now)");
});

it("shows a helper that refused GOAT at once, and does not promise to keep asking it", async () => {
  const f = fixture();
  const message = "GOAT Computer Use did not answer: it refused GOAT.";
  f.helper.unanswered = { principal: "unusable", message, unanswered: "refused" };
  await using _screen = await dialog(f);
  await refocus();
  expect(text()).toContain(message);
  expect(text()).toContain("it cannot tell whether one is missing");
  expect(text()).not.toContain("keeps asking");
  expect(button("Try again")).toBeDefined();
});

it("asks on its timer again once a read after a refusal fails outright, and shows the grants when the helper answers, with no focus or click", async () => {
  // The polling interval starts with the first render, so the clock is fake before it.
  using _timers = fakeTimers();
  const f = fixture();
  const refused = "GOAT Computer Use did not answer: it refused GOAT.";
  f.helper.unanswered = { principal: "unusable", message: refused, unanswered: "refused" };
  await using _screen = await dialog(f);
  await refocus();
  expect(text()).toContain(refused);
  // A refusal stays that way, so the timer leaves it alone.
  const calls = f.onCheck.mock.calls.length;
  await act(() => vi.advanceTimersByTime(6000));
  expect(f.onCheck).toHaveBeenCalledTimes(calls);

  // Coming back to GOAT asks once more, and that read cannot be made at all.
  f.onCheck.mockRejectedValueOnce(new Error("Error invoking remote method"));
  await refocus();
  expect(text()).toContain("GOAT could not check the permissions on this Mac.");
  expect(text()).toContain("keeps asking");

  // The helper recovers. Only the timer asks from here on.
  f.helper.unanswered = undefined;
  await act(() => vi.advanceTimersByTimeAsync(1500));
  expect(f.onCheck).toHaveBeenCalledTimes(calls + 2);
  expect(text()).toContain("Step 1 · Accessibility (to do now)");
  expect(text()).not.toContain("GOAT could not check");
});

it("shows a broken helper's reason and offers no other app to allow", async () => {
  const f = fixture({ unusable: "GOAT Computer Use at /x cannot be used (EACCES)." });
  await using _screen = await dialog(f);
  await refocus();
  expect(text()).toContain("GOAT Computer Use at /x cannot be used (EACCES).");
  expect(button("Open Settings")).toBeUndefined();
  expect(button("Turn on")?.disabled).toBe(true);
});

it("offers Quit & reopen when the restarted driver still lacks the grants", async () => {
  const f = fixture();
  f.onVerify.mockResolvedValueOnce({
    verified: false,
    steps: [
      { id: "grants", ok: true },
      { id: "restart", ok: true },
      { id: "permissions", ok: false, detail: "Computer use does not see Screen Recording yet." },
    ],
  });
  await using _screen = await dialog(f);
  await allowAll();
  await click("Turn on");
  await click("Quit & reopen");
  expect(f.onRelaunch).toHaveBeenCalledTimes(1);
});

it("leaves computer use off when the person chooses Later", async () => {
  const f = fixture();
  await using _screen = await dialog(f);
  await click("Later");
  expect(f.onEnable).not.toHaveBeenCalled();
  expect(f.onClose).toHaveBeenCalledWith("dismissed");
});

it("shows a failed save and does not check a driver that was never turned on", async () => {
  const f = fixture();
  f.onEnable.mockResolvedValueOnce("This connection cannot change settings on this host.");
  await using _screen = await dialog(f);
  await allowAll();
  await click("Turn on");
  expect(document.body.textContent).toContain(
    "This connection cannot change settings on this host.",
  );
  expect(f.onVerify).not.toHaveBeenCalled();
  expect(button("Later")).toBeDefined();
});

it("explains a remote Wayland host's needs and turns on without macOS checks", async () => {
  const f = fixture();
  await using _screen = await dialog(f, {
    status: { platform: "linux", running: false, wayland: true },
    localMac: false,
  });
  expect(document.body.textContent).toContain(
    "needs a signed-in desktop session or a virtual display such as Xvfb",
  );
  expect(document.body.textContent).toContain("Wayland");
  expect(button("Open Settings")).toBeUndefined();
  await click("Turn on");
  expect(f.onEnable).toHaveBeenCalledTimes(1);
  expect(f.onVerify).not.toHaveBeenCalled();
  expect(f.onCheck).not.toHaveBeenCalled();
  expect(f.onClose).toHaveBeenCalledWith("enabled");
});

it("stops asking a broken helper on a timer and asks again when GOAT regains focus", async () => {
  const message = "GOAT Computer Use cannot be used: protocol mismatch.";
  // The polling interval starts with the first render, so the clock is fake before it.
  using _timers = fakeTimers();
  const f = fixture({ unusable: message });
  await using _screen = await dialog(f);
  await vi.waitFor(() => expect(text()).toContain(message));
  const calls = f.onCheck.mock.calls.length;
  await act(() => vi.advanceTimersByTime(6000));
  expect(f.onCheck).toHaveBeenCalledTimes(calls);
  await refocus();
  expect(f.onCheck).toHaveBeenCalledTimes(calls + 1);
});
