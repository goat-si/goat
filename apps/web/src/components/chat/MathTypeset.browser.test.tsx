import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import MathTypeset from "./MathTypeset";

it("typesets an equation with an unescaped percent instead of showing its fallback", async () => {
  // This isolated formula has no routes.
  await using screen = await render(
    <MathTypeset
      tex={"\\text{3.18% yield}"}
      display={false}
      fallback={<span>Unrendered formula</span>}
    />,
    { router: false },
  );
  expect(screen.container.querySelector(".katex")).not.toBeNull();
  expect(screen.container.textContent).not.toContain("Unrendered formula");
});
