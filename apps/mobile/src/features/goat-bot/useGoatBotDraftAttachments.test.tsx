import { act, useLayoutEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import {
  isComposerAttachmentFileRetained,
  retainComposerAttachmentFile,
} from "../../lib/composerAttachmentFiles";
import type { DraftComposerAttachment } from "../../lib/composerImages";

// The real pick lifecycle, draft ownership and + menu; only the native pickers, the native menu and
// file deletion stand in.
const native = vi.hoisted(() => ({
  pickMedia: vi.fn(),
  pickFiles: vi.fn(),
  alert: vi.fn(),
  release: vi.fn(async (_files: ReadonlyArray<unknown>) => {}),
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
// While mounted, the native menu offers its actions; a button per action stands for choosing one,
// and "Open menu" for the system showing it.
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: {
    actions: ReadonlyArray<{ id: string; title: string }>;
    accessibilityState?: { expanded?: boolean };
    onOpenMenu?: () => void;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => (
    <div aria-label="Menu" data-expanded={String(props.accessibilityState?.expanded)}>
      <button aria-label="Open menu" onClick={props.onOpenMenu} />
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

import type { GoatBotAttachmentPickTarget } from "./GoatBotComposerAttachments";
import { GoatBotComposerMenu } from "./GoatBotComposerMenu";
import { useGoatBotDraftAttachments } from "./useGoatBotDraftAttachments";

const photo = (id: string) =>
  ({
    id,
    type: "image",
    name: `${id}.jpg`,
    mimeType: "image/jpeg",
    sizeBytes: 4,
    fileUri: `file:///documents/${id}.jpg`,
  }) as unknown as DraftComposerAttachment;

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  native.pickMedia.mockReset();
  native.pickFiles.mockReset();
  native.alert.mockReset();
  native.release.mockClear();
}

/** The photo picker answers when the test says so. */
function heldPick() {
  const pick = Promise.withResolvers<{ attachments: DraftComposerAttachment[]; error?: string }>();
  native.pickMedia.mockReturnValueOnce(pick.promise);
  return (attachments: DraftComposerAttachment[], error?: string) =>
    act(async () => {
      pick.resolve({ attachments, ...(error === undefined ? {} : { error }) });
      await pick.promise;
    });
}

type Seen = { target: GoatBotAttachmentPickTarget | null };
interface ComposerProps {
  readonly shown: boolean;
  readonly foreground: boolean;
  /** The draft owner's generation; another number is another conversation. */
  readonly owner?: number;
  /** Gets the pick target the menu last received, the one a pick captures when it starts. */
  readonly onTarget?: (target: GoatBotAttachmentPickTarget) => void;
  /** Runs inside the commit that renders these props, before any later work can answer. */
  readonly inCommit?: () => void;
}

function InCommit({ run }: { readonly run?: (() => void) | undefined }) {
  useLayoutEffect(() => {
    run?.();
  }, [run]);
  return null;
}

function Composer(props: ComposerProps) {
  const files = useGoatBotDraftAttachments(props.shown, props.owner ?? 0);
  const target = files.target(10_000_000);
  const { onTarget } = props;
  useLayoutEffect(() => {
    onTarget?.(target);
  });
  return (
    <>
      <InCommit run={props.inCommit} />
      <GoatBotComposerMenu
        shown={props.shown && props.foreground}
        disabled={false}
        attach={target}
        onNewRoutine={() => {}}
      />
      <output aria-label="Files">{files.attachments.map((file) => file.id).join(",")}</output>
      <output aria-label="Busy">{files.intake}</output>
      {files.attachments.map((file) => (
        <button
          key={file.id}
          aria-label={`Remove ${file.id}`}
          onClick={() => files.remove(file.id)}
        />
      ))}
      {files.attachments.map((file) => (
        <button
          key={file.id}
          aria-label={`Remove ${file.id} twice`}
          onClick={() => {
            files.remove(file.id);
            files.remove(file.id);
          }}
        />
      ))}
      <button aria-label="Sent" onClick={files.sent} />
    </>
  );
}

async function render(shown = true, foreground = true, seen?: Seen) {
  const onTarget = seen
    ? (target: GoatBotAttachmentPickTarget) => {
        seen.target = target;
      }
    : undefined;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const draw = (next: ComposerProps) => act(async () => root.render(<Composer {...next} />));
  await draw({ shown, foreground, ...(onTarget ? { onTarget } : {}) });
  const find = (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  return {
    draw,
    press: (label: string) => act(async () => find(label)?.click()),
    has: (label: string) => find(label) !== null,
    expanded: () => find("Menu")?.getAttribute("data-expanded"),
    files: () => find("Files")?.textContent ?? "",
    busy: () => find("Busy")?.textContent,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("a pick that answers while the app is in the background joins the message, as after Android's photo picker", async () => {
  setup();
  const answer = heldPick();
  const view = await render();
  try {
    await view.press("Photo Library");
    expect(view.busy()).toBe("1");
    await view.draw({ shown: true, foreground: false });
    await answer([photo("p1")]);
    expect(view.files()).toBe("p1");
    expect(view.busy()).toBe("0");
    expect(isComposerAttachmentFileRetained("file:///documents/p1.jpg")).toBe(true);
    expect(native.release).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
  }
});

it("a pick that answers after the chat stopped being shown is released, and the box is free again", async () => {
  setup();
  const answer = heldPick();
  const view = await render();
  try {
    await view.press("Photo Library");
    await view.draw({ shown: false, foreground: true });
    expect(view.busy()).toBe("0");
    await answer([photo("p2")]);
    expect(view.files()).toBe("");
    expect(native.release).toHaveBeenCalledWith([photo("p2")]);
    expect(isComposerAttachmentFileRetained("file:///documents/p2.jpg")).toBe(false);
    // Shown again, the chat picks as before.
    const again = heldPick();
    await view.draw({ shown: true, foreground: true });
    await view.press("Photo Library");
    await again([photo("p3")]);
    expect(view.files()).toBe("p3");
  } finally {
    await view.unmount();
  }
});

it("the + menu is taken down while the chat is not shown or the app is in the background", async () => {
  setup();
  const view = await render();
  try {
    expect(view.has("New routine")).toBe(true);
    await view.draw({ shown: true, foreground: false });
    expect(view.has("New routine")).toBe(false);
    expect(view.has("Add to message")).toBe(true);
    await view.draw({ shown: false, foreground: true });
    expect(view.has("Photo Library")).toBe(false);
    await view.draw({ shown: true, foreground: true });
    expect(view.has("Photo Library")).toBe(true);
  } finally {
    await view.unmount();
  }
});

it("a menu taken down while open comes back closed", async () => {
  setup();
  const view = await render();
  try {
    await view.press("Open menu");
    expect(view.expanded()).toBe("true");
    await view.draw({ shown: true, foreground: false });
    await view.draw({ shown: true, foreground: true });
    expect(view.expanded()).toBe("false");
  } finally {
    await view.unmount();
  }
});

it("two picks together never fill the message past its attachment limit; the extra files are released", async () => {
  setup();
  const first = heldPick();
  const second = heldPick();
  const view = await render();
  try {
    await view.press("Photo Library");
    await view.press("Photo Library");
    const batch = (prefix: string) =>
      Array.from({ length: 60 }, (_, index) => photo(`${prefix}${index}`));
    const one = batch("a");
    const two = batch("b");
    await first(one);
    await second(two);
    expect(view.files().split(",")).toHaveLength(100);
    expect(native.release).toHaveBeenCalledWith(two.slice(40));
    expect(isComposerAttachmentFileRetained("file:///documents/b40.jpg")).toBe(false);
    expect(native.alert).toHaveBeenCalledWith(
      "Could not attach file",
      "You can attach up to 100 files per message.",
    );
    expect(view.busy()).toBe("0");
  } finally {
    await view.unmount();
  }
});

it("a pick that answers after the chat moved to another conversation is released, and the box is free", async () => {
  setup();
  const answer = heldPick();
  const view = await render();
  try {
    await view.press("Photo Library");
    await view.draw({ shown: true, foreground: true, owner: 1 });
    expect(view.busy()).toBe("0");
    await answer([photo("moved")]);
    expect(view.files()).toBe("");
    expect(native.release).toHaveBeenCalledWith([photo("moved")]);
    expect(isComposerAttachmentFileRetained("file:///documents/moved.jpg")).toBe(false);
  } finally {
    await view.unmount();
  }
});

it("a pick that answers in the very commit that moves the chat to another conversation is released", async () => {
  setup();
  const seen: Seen = { target: null };
  const view = await render(true, true, seen);
  try {
    const started = seen.target;
    const lifetime = started?.getLifetime();
    if (!started || !lifetime) throw new Error("expected a pick target");
    await view.draw({
      shown: true,
      foreground: true,
      owner: 1,
      inCommit: () => started.onPicked([photo("crossing")], lifetime),
    });
    expect(view.files()).toBe("");
    expect(native.release).toHaveBeenCalledWith([photo("crossing")]);
    expect(isComposerAttachmentFileRetained("file:///documents/crossing.jpg")).toBe(false);
  } finally {
    await view.unmount();
  }
});

it("removing a file twice before the list renders counts it once, so the limit still holds", async () => {
  setup();
  const first = heldPick();
  const second = heldPick();
  const third = heldPick();
  const view = await render();
  try {
    await view.press("Photo Library");
    await first([photo("k1"), photo("k2")]);
    await view.press("Remove k1 twice");
    expect(view.files()).toBe("k2");
    await view.press("Photo Library");
    await second(Array.from({ length: 99 }, (_, index) => photo(`f${index}`)));
    await view.press("Photo Library");
    await third([photo("over")]);
    expect(view.files().split(",")).toHaveLength(100);
    expect(native.release).toHaveBeenCalledWith([photo("over")]);
  } finally {
    await view.unmount();
  }
});

it("the same files answered twice join the message once and stay on disk", async () => {
  setup();
  const seen: Seen = { target: null };
  const view = await render(true, true, seen);
  try {
    const target = seen.target;
    const lifetime = target?.getLifetime();
    if (!target || !lifetime) throw new Error("expected a pick target");
    await act(async () => {
      target.onPicked([photo("twice")], lifetime);
      target.onPicked([photo("twice")], lifetime);
    });
    expect(view.files()).toBe("twice");
    expect(native.release).not.toHaveBeenCalled();
    expect(isComposerAttachmentFileRetained("file:///documents/twice.jpg")).toBe(true);
  } finally {
    await view.unmount();
  }
});

it("a pick past the limit that also brings the picker's own error says one thing", async () => {
  setup();
  const first = heldPick();
  const second = heldPick();
  const view = await render();
  try {
    await view.press("Photo Library");
    await first(Array.from({ length: 100 }, (_, index) => photo(`g${index}`)));
    await view.press("Photo Library");
    await second([photo("extra")], "That file is too large.");
    expect(native.alert).toHaveBeenCalledTimes(1);
    expect(native.alert).toHaveBeenCalledWith("Could not attach file", "That file is too large.");
    expect(native.release).toHaveBeenCalledWith([photo("extra")]);
  } finally {
    await view.unmount();
  }
});

it("a removed file is deleted, and a sent message's files stay with whoever sends them", async () => {
  setup();
  const answer = heldPick();
  const view = await render();
  try {
    await view.press("Photo Library");
    await answer([photo("keep"), photo("drop")]);
    await view.press("Remove drop");
    expect(view.files()).toBe("keep");
    expect(native.release).toHaveBeenCalledWith([photo("drop")]);
    expect(isComposerAttachmentFileRetained("file:///documents/drop.jpg")).toBe(false);
    // The send queue holds the files it took, as the session does, before the draft lets go.
    const queued = retainComposerAttachmentFile("file:///documents/keep.jpg", () => {});
    native.release.mockClear();
    await view.press("Sent");
    expect(view.files()).toBe("");
    expect(native.release).not.toHaveBeenCalled();
    expect(isComposerAttachmentFileRetained("file:///documents/keep.jpg")).toBe(true);
    queued();
  } finally {
    await view.unmount();
  }
});

it("unmounting releases the files the draft still holds", async () => {
  setup();
  const answer = heldPick();
  const view = await render();
  await view.press("Photo Library");
  await answer([photo("left")]);
  await view.unmount();
  expect(native.release).toHaveBeenCalledWith([photo("left")]);
  expect(isComposerAttachmentFileRetained("file:///documents/left.jpg")).toBe(false);
});
