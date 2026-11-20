import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { CodexArtifactTemplateCard } from "./CodexArtifactTemplateCard";

it("renders an Arabic template in its reading direction and keeps its action", async () => {
  const template = {
    artifactKind: "document" as const,
    displayName: "قالب تقرير",
    skillDirectory: "/test/template",
    skillName: "report",
  };
  const onUse = vi.fn();
  await using screen = await render(
    <CodexArtifactTemplateCard template={template} onUse={onUse} />,
  );
  const card = screen.getByRole("group", { name: "قالب تقرير template" });
  await expect.element(card).toBeVisible();
  expect(getComputedStyle(card.element()).direction).toBe("rtl");
  await userEvent.click(screen.getByRole("button", { name: "Use template" }));
  expect(onUse).toHaveBeenCalledWith(template);
});

it("keeps left-to-right reading order for an English template", async () => {
  const template = {
    artifactKind: "document" as const,
    displayName: "Report template",
    skillDirectory: "/test/template",
    skillName: "report",
  };
  await using screen = await render(<CodexArtifactTemplateCard template={template} />);
  const card = screen.getByRole("group", { name: "Report template template" });
  await expect.element(card).toBeVisible();
  expect(getComputedStyle(card.element()).direction).toBe("ltr");
});
