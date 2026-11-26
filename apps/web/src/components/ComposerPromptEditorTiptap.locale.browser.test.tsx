import { GTProvider } from "gt-react";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render";
import zh from "../i18n/translations/zh.json";
import { Composer, editorIn } from "./ComposerPromptEditorTiptap.input.test-support";

it("updates skill and file chip names in a mounted editor when the locale changes", async () => {
  const path = "src/surface.test.ts";
  const composer = (
    <Composer
      value={`Use $frontend-design with [surface.test.ts](${path}) before shipping.`}
      skills={[
        { name: "frontend-design", path: ".agents/skills/frontend-design/SKILL.md", enabled: true },
      ]}
      richTextEnabled
    />
  );
  const localized = (locale: string) => (
    <GTProvider locale={locale} translations={{ zh }}>
      {composer}
    </GTProvider>
  );
  await using screen = await render(localized("en"));
  const editor = editorIn(screen.container);
  await expect
    .element(screen.getByRole("button", { name: "Skill frontend-design. Show details" }))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: `Preview ${path}` })).toBeVisible();
  const document = editor.getJSON();

  await screen.rerender(localized("zh"));
  await expect.element(screen.getByRole("button", { name: `预览 ${path}` })).toBeVisible();
  await screen.getByRole("button", { name: "技能 frontend-design。查看详情" }).click();
  await expect.element(page.getByText("此技能暂无说明。")).toBeVisible();
  expect(editorIn(screen.container)).toBe(editor);
  expect(editor.getJSON()).toEqual(document);
});
