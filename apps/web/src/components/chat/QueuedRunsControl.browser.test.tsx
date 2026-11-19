import {
  formatComposerContextReference,
  toComposerContextId,
} from "@goat/shared/composerContextReferences";
import { EnvironmentId, MessageId, ThreadId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { serializeAssistantCitation } from "@goat/shared/assistantCitations";
import { createRef, type ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  workflow: null as unknown,
  commandResult: undefined as unknown,
}));

vi.mock(import("@goat/client-runtime/state/thread-workflows"), async (importOriginal) => ({
  ...(await importOriginal()),
  deriveThreadQueueWorkflowState: (() => state.workflow) as never,
}));

vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useQuietThreadProjection: (() => state.projection) as never,
}));

vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => async () => state.commandResult) as never,
}));

vi.mock(import("../../assets/assetUrls"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAssetUrls: ((_environmentId: never, resources: ReadonlyArray<{ attachmentId: string }>) =>
    resources.map((resource) => `https://assets.test/${resource.attachmentId}`)) as never,
}));

import { ToastProvider } from "../ui/toast";
import { render as renderUi } from "../../../test/render";
import { QueuedRunsControl, type QueuedRunsControlHandle } from "./QueuedRunsControl";

function setup() {
  state.projection = null;
  state.workflow = null;
  state.commandResult = undefined;
}

const baseProps = {
  environmentId: "environment:test" as never,
  optimisticMessages: [],
  threadId: "thread:test" as never,
  editingRunId: null,
  editBlockedReason: null,
  onEditQueuedRun: () => undefined,
  onCancelEdit: () => undefined,
} satisfies ComponentProps<typeof QueuedRunsControl>;

async function renderQueue(props: Partial<ComponentProps<typeof QueuedRunsControl>> = {}) {
  return renderUi(<QueuedRunsControl {...baseProps} {...props} />);
}

it("previews assistant quotes as readable text and preserves the citation when editing", async () => {
  setup();
  const quotedText = "Cache the parsed config per worktree.";
  const quote = serializeAssistantCitation({
    version: 1,
    environmentId: EnvironmentId.make("environment:test"),
    threadId: ThreadId.make("thread:test"),
    messageId: MessageId.make("message:assistant"),
    text: quotedText,
    start: 0,
    end: quotedText.length,
    prefix: "",
    suffix: "",
  });
  const quoteAndText = `${quote}\n\nWhy per worktree?`;
  const inlineImage = formatComposerContextReference({
    kind: "image",
    contextId: toComposerContextId("header"),
    label: "header.png",
  });
  state.projection = { projection: { messages: [] } };
  state.workflow = {
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    canReorder: true,
    queuedRuns: [
      {
        run: { id: "run:quote-only", userMessageId: "message:quote-only" },
        text: quote,
        attachments: [],
      },
      {
        run: { id: "run:quote-and-text", userMessageId: "message:quote-and-text" },
        text: quoteAndText,
        attachments: [],
      },
      {
        run: { id: "run:inline-image", userMessageId: "message:inline-image" },
        text: `Make the header look like ${inlineImage} and keep the logo.`,
        attachments: [{ type: "image", id: "attachment:header", name: "header.png" }],
      },
    ],
  };
  const onEditQueuedRun = vi.fn();
  await using _screen = await renderQueue({ onEditQueuedRun });

  await expect.element(page.getByText(quotedText, { exact: true })).toBeVisible();
  await expect
    .element(page.getByText(`${quotedText} Why per worktree?`, { exact: true }))
    .toBeVisible();

  await expect
    .element(
      page.getByText("Make the header look like header.png and keep the logo.", { exact: true }),
    )
    .toBeVisible();

  await page.getByRole("button", { name: "Edit queued message", exact: true }).nth(1).click();
  expect(onEditQueuedRun).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ text: quoteAndText }),
  );
});

it("blocks button and keyboard edits while a question owns the composer and unlocks afterward", async () => {
  setup();
  state.projection = { projection: { messages: [] } };
  state.workflow = {
    queuedRuns: [
      {
        run: { id: "run:queued", userMessageId: "message:queued" },
        text: "Queued",
        attachments: [],
      },
    ],
    canReorder: true,
    canPromoteToSteer: false,
  };
  const ref = createRef<QueuedRunsControlHandle>();
  const onEditQueuedRun = vi.fn();
  const props = { ...baseProps, ref, onEditQueuedRun };
  await using screen = await renderUi(
    <QueuedRunsControl
      {...props}
      editBlockedReason="Answer the question to edit queued messages"
    />,
  );
  await expect
    .element(page.getByRole("button", { name: "Edit queued message", exact: true }))
    .toBeDisabled();
  expect(ref.current?.editLatest(false)).toBe(false);
  expect(onEditQueuedRun).not.toHaveBeenCalled();
  await screen.rerender(<QueuedRunsControl {...props} editBlockedReason={null} />);
  await expect
    .element(page.getByRole("button", { name: "Edit queued message", exact: true }))
    .toBeEnabled();
  expect(ref.current?.editLatest(false)).toBe(true);
  expect(onEditQueuedRun).toHaveBeenCalledOnce();
});

it.each(["Send now", "Steer"] as const)("shows the refusal from %s", async (action) => {
  setup();
  state.projection = { projection: { messages: [] } };
  state.workflow = {
    activeRun: action === "Steer" ? { id: "run:active" } : null,
    canSendNow: action === "Send now",
    canPromoteToSteer: action === "Steer",
    queuedRuns: [
      {
        run: { id: "run:queued", userMessageId: "message:queued" },
        text: "Follow up",
        attachments: [],
      },
    ],
  };
  const reason = "The target changed while you were editing the queue.";
  state.commandResult = AsyncResult.failure(Cause.fail(new Error(reason)));
  await using _screen = await renderUi(
    <ToastProvider timeout={0}>
      <QueuedRunsControl {...baseProps} />
    </ToastProvider>,
  );

  await page.getByRole("button", { name: action }).click();
  await expect.element(page.getByText(reason)).toBeVisible();
});

it("leaves the queued message available when sending is interrupted", async () => {
  setup();
  state.projection = { projection: { messages: [] } };
  state.workflow = {
    activeRun: null,
    canSendNow: true,
    queuedRuns: [
      {
        run: { id: "run:queued", userMessageId: "message:queued" },
        text: "Follow up",
        attachments: [],
      },
    ],
  };
  state.commandResult = AsyncResult.failure(Cause.interrupt());
  await using _screen = await renderUi(
    <ToastProvider timeout={0}>
      <QueuedRunsControl {...baseProps} />
    </ToastProvider>,
  );

  const send = page.getByRole("button", { name: "Send now" });
  await send.click();
  await expect.element(send).toBeEnabled();
  await expect.element(page.getByText("Could not send queued message")).not.toBeInTheDocument();
});
