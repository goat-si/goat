import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { GlobeIcon, PlusIcon } from "~/components/solar";

import { expectAlignedControlRow } from "../../../test/controlRowLayout";
import { render } from "../../../test/render";
import { Button } from "../ui/button";
import { ComposerControl, ComposerControlChevron, ComposerControlIcon } from "./ComposerControl";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerVoiceButton } from "./ComposerVoiceButton";

/** Desktop width: below sm, controls take their larger touch sizes on purpose. */
const desktop = () => page.viewport(1280, 800);

const controls = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>("[data-row] > *, [data-row] > * > button"),
];

describe("composer control rows", () => {
  it("line up the composer footer's primitives on one height, one center line and even gaps", async () => {
    await desktop();
    await using screen = await render(
      <div data-row className="flex items-center gap-1 [--composer-control-text-scale:0.8]">
        <Button variant="ghost" size="icon-sm" aria-label="Attach files">
          <PlusIcon />
        </Button>
        <ComposerControl aria-label="Runtime mode">
          <ComposerControlIcon icon={GlobeIcon} />
          <span data-composer-control-label>Full access</span>
        </ComposerControl>
        <ComposerControl aria-label="Model">
          <ComposerControlIcon icon={GlobeIcon} />
          <span data-chat-provider-model-picker-label>6 Astra</span>
        </ComposerControl>
        <ComposerControl aria-label="Reasoning">
          <span>Medium Fast</span>
        </ComposerControl>
        <ComposerVoiceButton onClick={() => {}} />
      </div>,
      // These isolated controls do not use navigation.
      { router: false },
    );
    expectAlignedControlRow(controls(screen.container), { evenGaps: true });
  });

  it("keeps the round send button on the row's height and seen by its edge", async () => {
    await desktop();
    await using screen = await render(
      <div data-row className="flex items-center gap-2.5">
        <ComposerPrimaryActions
          voiceControl={{ onClick: () => {} }}
          compact={false}
          canOperateThread
          pendingAction={null}
          isRunning={false}
          canInterrupt={false}
          showPlanFollowUpPrompt={false}
          promptHasText
          isSendBusy={false}
          sendDisabledReason={null}
          isConnecting={false}
          isEnvironmentUnavailable={false}
          isPreparingWorktree={false}
          hasSendableContent
          onPreviousPendingQuestion={() => {}}
          onInterrupt={() => {}}
          onImplementPlanInNewThread={() => {}}
        />
      </div>,
      // These isolated controls do not use navigation.
      { router: false },
    );
    const voice = screen.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Record voice input"]',
    );
    const send = screen.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Submit message"]',
    );
    expect(voice).not.toBeNull();
    expect(send).not.toBeNull();
    expectAlignedControlRow([voice!, send!], { filled: [send!] });
    expect(send!.getBoundingClientRect().width).toBe(28);
    expect(send!.getBoundingClientRect().height).toBe(28);
    expect(screen.container.querySelector("[data-row]")!.getBoundingClientRect().height).toBe(28);
  });

  it("gives a control with a chevron the same padding on both sides", async () => {
    await desktop();
    await using screen = await render(
      <div data-row className="flex items-center gap-1">
        <h1 className="goat-name-capsule">GOAT Bot</h1>
        <ComposerControl aria-label="Model">
          <ComposerControlIcon icon={GlobeIcon} />
          <span data-chat-provider-model-picker-label>6 Astra</span>
          <ComposerControlChevron />
        </ComposerControl>
        <ComposerControl aria-label="Thread mode">
          <ComposerControlIcon icon={GlobeIcon} />
          <span data-composer-control-label>Thread mode</span>
        </ComposerControl>
      </div>,
      // These isolated controls do not use navigation.
      { router: false },
    );
    const row = controls(screen.container);
    expect(row).toHaveLength(3);
    expectAlignedControlRow(row);
  });
});

it("offers destination choice before recording on first use", async () => {
  const onClick = vi.fn();
  const enable = vi.fn();
  const disable = vi.fn();
  await using screen = await render(
    <ComposerVoiceButton
      onClick={onClick}
      environmentSpeech={{
        choice: "unset",
        label: "Local",
        selected: false,
        environmentId: EnvironmentId.make("local"),
        canManage: false,
        resolveContext: async () => null,
        destinations: [{ environmentId: EnvironmentId.make("local"), label: "Local" }],
        enable,
        disable,
        useExisting: vi.fn(),
      }}
    />,
  );
  await screen.getByRole("button", { name: "Record voice input" }).click();
  await expect.element(screen.getByRole("dialog", { name: "Set up voice input" })).toBeVisible();
  expect(onClick).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: "Turn off voice input" }).click();
  expect(disable).toHaveBeenCalledOnce();
  expect(enable).not.toHaveBeenCalled();
});
