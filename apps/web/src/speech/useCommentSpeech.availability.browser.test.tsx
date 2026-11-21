import { EnvironmentId } from "@goat/contracts";
import * as Option from "effect/Option";
import { useRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";

const state = vi.hoisted(() => ({ captured: undefined as undefined | { liveEnabled?: boolean } }));
vi.mock("../components/chat/useComposerVoiceController", () => ({
  useComposerVoiceController: (options: { liveEnabled?: boolean }) => {
    state.captured = options;
    return {};
  },
}));
vi.mock("./voiceConsent", () => ({
  useEnvironmentSpeechGrant: () => ({ environmentId: EnvironmentId.make("fixture") }),
}));
vi.mock("../hooks/useSettings", async (original) => ({
  ...(await original()),
  useClientSettings: () => false,
}));
vi.mock("../state/session", async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  usePreparedConnection: () => Option.some({ target: { _tag: "Direct" } }),
}));
vi.mock("../state/environments", async (original) => ({
  ...(await original()),
  useEnvironment: () => ({ label: "Fixture" }),
}));
vi.mock("../state/server", async (original) => {
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make({ speechStreamingV1: true, speechStreamingModelIds: ["supported"] });
  const settings = Atom.make({ speech: { modelId: "unsupported" } });
  const actual = (await original()) as typeof import("../state/server");
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: () => config,
      settingsValueAtom: () => settings,
    },
  };
});
import { useCommentSpeech } from "./useCommentSpeech";

it("keeps comment dictation batch-only for an unsupported selected model", async () => {
  function Fixture() {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    useCommentSpeech({
      environmentId: EnvironmentId.make("fixture"),
      textareaRef,
      text: "",
      onTextChange: () => {},
    });
    return <textarea ref={textareaRef} />;
  }
  await using screen = await render(<Fixture />, { router: false }); // The control does not navigate.
  expect(screen.getByRole("textbox")).toBeDefined();
  expect(state.captured?.liveEnabled).toBe(false);
});
