import { expect, it } from "vite-plus/test";
import { act, render } from "../../../test/render";
import "../../index.css";
import { RedactedSensitiveText } from "./RedactedSensitiveText";

it("keeps the email until the hide blur finishes", async () => {
  const email = "developer@example.com";
  await using screen = await render(
    <RedactedSensitiveText
      value={email}
      ariaLabel="Email"
      revealTooltip="Reveal"
      hideTooltip="Hide"
    />,
  );
  const toggle = screen.getByRole("button", { name: "Email" });
  const button = toggle.element() as HTMLButtonElement;
  button.style.setProperty("transition", "filter 10s linear", "important");
  expect(getComputedStyle(button).filter).not.toBe("none");
  await act(() => button.click());
  for (const animation of button.getAnimations()) animation.finish();
  await expect.element(toggle).toHaveTextContent(email);
  expect(getComputedStyle(button).filter).toBe("none");
  await act(() => button.click());
  const blur = button
    .getAnimations()
    .find(
      (animation) =>
        animation instanceof CSSTransition && animation.transitionProperty === "filter",
    );
  expect(blur).toBeDefined();
  if (!blur) throw new Error("Expected a filter transition");
  blur.pause();
  expect(button.textContent).toBe(email);
  await act(() => blur.finish());
  await expect.element(toggle).not.toHaveTextContent(email);
});
