import { act, useImperativeHandle, useRef, type Ref } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("../../components/ui/AppText", () => ({
  AppTextInput: ({
    ref,
    defaultValue,
    value,
    onChangeText,
  }: {
    ref: Ref<{ clear: () => void }>;
    defaultValue?: string;
    value?: string;
    onChangeText: (text: string) => void;
  }) => {
    const input = useRef<HTMLInputElement>(null);
    useImperativeHandle(ref, () => ({
      clear: () => {
        if (input.current) input.current.value = "";
      },
    }));
    return (
      <input
        ref={input}
        defaultValue={defaultValue}
        value={value}
        onInput={(event) => onChangeText(event.currentTarget.value)}
      />
    );
  },
}));
import { CustomAnswerInput } from "./CustomAnswerInput";

it("retains native text across parent updates and clears it when an option is selected", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const onChangeText = vi.fn();
  const render = (value: string) =>
    root.render(
      <CustomAnswerInput
        value={value}
        multiline={false}
        disabled={false}
        onChangeText={onChangeText}
        onFocus={() => {}}
        onBlur={() => {}}
      />,
    );
  try {
    await act(() => render("draft"));
    const input = container.querySelector("input");
    expect(input?.value).toBe("draft");
    if (input) input.value = "native composition";
    await act(() => render("draft"));
    expect(input?.value).toBe("native composition");
    await act(() => {
      if (input) {
        input.value = "draft corrected";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    expect(onChangeText).toHaveBeenCalledWith("draft corrected");
    await act(() => render("draft corrected"));
    expect(input?.value).toBe("draft corrected");
    await act(() => render(""));
    expect(input?.value).toBe("");
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
