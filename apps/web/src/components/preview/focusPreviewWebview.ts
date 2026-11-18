export function focusPreviewWebview(runtimeTabId: string) {
  document
    .querySelector<HTMLElement>(`[data-preview-viewport="${CSS.escape(runtimeTabId)}"] webview`)
    ?.focus();
}
