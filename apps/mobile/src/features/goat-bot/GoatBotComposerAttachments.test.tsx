import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import type { DraftComposerAttachment } from "../../lib/composerImages";

const native = vi.hoisted(() => ({
  pickMedia: vi.fn(),
  pickFiles: vi.fn(),
  alert: vi.fn(),
  release: vi.fn(async () => {}),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Pressable: (props: {
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress?: () => void;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} disabled={props.disabled} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("../../components/ui/useAndroidControlSizing", () => ({
  useAndroidControlSizing: () => ({ scale: 1 }),
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
// The native menu shows its actions; a button per action stands for choosing it.
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: {
    actions: ReadonlyArray<{ id: string; title: string }>;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => (
    <div>
      {props.children}
      {props.actions.map((action) => (
        <button
          key={action.id}
          aria-label={action.title}
          onClick={() => props.onPressAction({ nativeEvent: { event: action.id } })}
        />
      ))}
    </div>
  ),
}));
vi.mock("../../lib/composerImages", () => ({
  pickComposerMedia: native.pickMedia,
  pickComposerFiles: native.pickFiles,
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: native.alert }));
vi.mock("../../state/use-composer-drafts", () => ({
  releaseUnusedComposerAttachmentFiles: native.release,
}));
vi.mock("../../components/ComposerAttachmentStrip", () => ({
  ComposerAttachmentStrip: () => null,
}));

import { GoatBotAttachButton } from "./GoatBotComposerAttachments";

const photo = { id: "a1", kind: "image" } as unknown as DraftComposerAttachment;

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  native.pickMedia.mockReset();
  native.pickFiles.mockReset();
  native.alert.mockReset();
  native.release.mockClear();
}

/** A picker call that answers when the test says so. */
function held() {
  let answer: (value: {
    attachments: DraftComposerAttachment[];
    error?: string;
  }) => void = () => {};
  let fail: (cause: unknown) => void = () => {};
  const promise = new Promise((resolve, reject) => {
    answer = resolve;
    fail = reject;
  });
  return { promise, answer, fail };
}

async function render(maxUploadBytes: number | null) {
  const lifetime = new AbortController();
  const onPicked = vi.fn();
  const intake: number[] = [];
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <GoatBotAttachButton
        disabled={false}
        existingCount={0}
        maxUploadBytes={maxUploadBytes}
        getLifetime={() => lifetime.signal}
        onPicked={onPicked}
        onIntake={(change) => intake.push(change)}
      />,
    ),
  );
  const press = (label: string) =>
    act(async () =>
      (container.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement).click(),
    );
  return {
    container,
    lifetime,
    onPicked,
    intake,
    press,
    unmount: () => act(async () => root.unmount()),
  };
}

it("on a server that takes photos only, the task screen's + picks photos at once", async () => {
  setup();
  const pick = held();
  native.pickMedia.mockReturnValue(pick.promise);
  const view = await render(null);
  expect(view.container.querySelector('[aria-label="Choose Files"]')).toBeNull();
  await view.press("Add attachment");
  expect(native.pickMedia).toHaveBeenCalledTimes(1);
  await act(async () => pick.answer({ attachments: [photo] }));
  expect(view.onPicked).toHaveBeenCalledWith([photo], expect.any(AbortSignal));
  expect(view.intake).toEqual([1, -1]);
  await view.unmount();
});

it("on a server that takes files, the task screen's + offers Photo Library and Choose Files", async () => {
  setup();
  const pick = held();
  native.pickFiles.mockReturnValue(pick.promise);
  const view = await render(1_000_000);
  expect(view.container.querySelector('[aria-label="Photo Library"]')).not.toBeNull();
  await view.press("Choose Files");
  expect(native.pickFiles).toHaveBeenCalledTimes(1);
  await act(async () => pick.answer({ attachments: [photo] }));
  expect(view.onPicked).toHaveBeenCalledWith([photo], expect.any(AbortSignal));
  await view.unmount();
});

it("releases a pick that answers after its screen has gone, and adds nothing", async () => {
  setup();
  const pick = held();
  native.pickMedia.mockReturnValue(pick.promise);
  const view = await render(null);
  await view.press("Add attachment");
  view.lifetime.abort();
  await act(async () => pick.answer({ attachments: [photo] }));
  expect(native.release).toHaveBeenCalledWith([photo]);
  expect(view.onPicked).not.toHaveBeenCalled();
  // The pick started while the screen lived; nothing reports its end to a screen that is gone.
  expect(view.intake).toEqual([1]);
  await view.unmount();
});

it("says a pick failed and ends it", async () => {
  setup();
  const pick = held();
  native.pickMedia.mockReturnValue(pick.promise);
  const view = await render(null);
  await view.press("Add attachment");
  await act(async () => pick.fail(new Error("The library is not available.")));
  expect(native.alert).toHaveBeenCalledWith(
    "Could not attach file",
    "The library is not available.",
  );
  expect(view.onPicked).not.toHaveBeenCalled();
  expect(view.intake).toEqual([1, -1]);
  await view.unmount();
});
