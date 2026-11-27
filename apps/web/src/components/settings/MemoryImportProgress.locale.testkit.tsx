import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { GTProvider } from "gt-react";
import { MemoryOperationId, type EnvironmentId, type MemorySpaceId } from "@goat/contracts";
import { expect } from "vite-plus/test";
import zh from "../../i18n/translations/zh.json";
import { memoryImportRecoveryStorage } from "../../lib/memoryImportRecoveryStorage";
import { MemoryImportSettings } from "./MemoryImportSettings";

export async function exerciseImportProgressLocale({
  state,
  envId,
  spaceId,
  renderControl,
  click,
  deferredResult,
  root,
  container,
  id,
}: {
  state: { executors: Map<string, (input: unknown) => Promise<unknown>> };
  envId: EnvironmentId;
  spaceId: MemorySpaceId;
  renderControl: (element: ReactNode) => Promise<unknown>;
  click: (label: string) => Promise<void>;
  deferredResult: () => Promise<{ promise: Promise<unknown>; resolve: (value: unknown) => void }>;
  root: Root;
  container: HTMLElement;
  id: (value: number) => string;
}) {
  const operationId = MemoryOperationId.make(id(77));
  await memoryImportRecoveryStorage().save(
    { environmentId: envId, memorySpaceId: spaceId },
    operationId,
  );
  state.executors.set("importProvider", async () => {
    throw new Error("offline");
  });
  try {
    await renderControl(
      <GTProvider locale="zh" translations={{ zh }}>
        <MemoryImportSettings environmentId={envId} memorySpaceId={spaceId} />
      </GTProvider>,
    );
    expect(container.textContent).toContain("重新连接并查看导入结果。");
    const pending = await deferredResult();
    state.executors.set("importProvider", () => pending.promise);
    await click("查看导入结果");
    await click("停止导入");
    expect(container.textContent).toContain("已停止后续批次。已发送的导入仍可能被应用。");
    await act(async () =>
      pending.resolve({
        action: "status",
        receipt: { operationId, state: "completed", items: [] },
      }),
    );
  } finally {
    await act(async () =>
      root.render(
        <GTProvider locale="en" translations={{}}>
          <span />
        </GTProvider>,
      ),
    );
  }
}
