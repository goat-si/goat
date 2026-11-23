import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";
import { GoatBotPackageExportDialog, GoatBotPackageImportDialog } from "./GoatBotPackageDialog";

const botPackage = {
  version: 1,
  name: "Build Scout",
  face: "🔎",
  color: "#286470",
  purpose: "Review builds.",
  instructions: "Summarize failures.",
  automations: [
    {
      title: "Check build",
      prompt: "Look for failures.",
      schedule: { type: "interval", everyMs: 60_000 },
    },
  ],
  tools: { mcpServers: ["deploy"], skills: ["review"] },
} as const;

it("previews the exact export before downloading it", async () => {
  const save = vi.fn();
  const contents = JSON.stringify(botPackage, null, 2);
  await using screen = await render(
    <GoatBotPackageExportDialog
      name="Build Scout"
      result={{ status: "ready", contents }}
      close={() => {}}
      save={save}
    />,
  );
  await expect
    .element(screen.getByRole("textbox", { name: "Package contents" }))
    .toHaveValue(contents);
  expect(save).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Save package" }));
  expect(save).toHaveBeenCalledExactlyOnceWith(contents);
});

it("shows the fields that block an export with no download action", async () => {
  await using screen = await render(
    <GoatBotPackageExportDialog
      name="Build Scout"
      result={{ status: "blocked", fields: ["/instructions"] }}
      close={() => {}}
      save={() => {}}
    />,
  );
  await expect.element(screen.getByText("/instructions")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Save package" }))
    .not.toBeInTheDocument();
});

it("shows the automation, tool names and dropped fields before confirming the reviewed digest", async () => {
  const confirm = vi.fn().mockResolvedValue(undefined);
  const review = vi.fn().mockResolvedValue({
    botPackage,
    digest: "a".repeat(64),
    droppedFields: ["/slack"],
  });
  const contents = JSON.stringify(botPackage);
  await using screen = await render(
    <GoatBotPackageImportDialog review={review} confirm={confirm} close={() => {}} />,
  );
  await userEvent.upload(
    screen.getByLabelText("Package file"),
    new File([contents], "scout.goatbot.json", { type: "application/json" }),
  );
  const packageText = screen.getByRole("textbox", { name: "Reviewed package" });
  await expect.element(packageText).toHaveValue(expect.stringContaining("Look for failures."));
  await expect.element(packageText).toHaveValue(expect.stringContaining("deploy"));
  await expect.element(screen.getByText("/slack")).toBeVisible();
  await expect.element(screen.getByText(/automations.*paused/i)).toBeVisible();
  expect(confirm).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Import bot" }));
  expect(confirm).toHaveBeenCalledExactlyOnceWith({
    text: contents,
    digest: "a".repeat(64),
    clientRequestId: expect.any(String),
  });
});
