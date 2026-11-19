import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { DiffFileHeaderSuffix } from "./DiffFileHeaderSuffix";

it("identifies an unfamiliar file change type", async () => {
  await using screen = await render(
    <DiffFileHeaderSuffix
      filePath="file.txt"
      hasStat
      error={false}
      unknownChangeType
      onRetry={() => {}}
    />,
  );
  await expect.element(screen.getByText("Unknown change type")).toBeVisible();
});
