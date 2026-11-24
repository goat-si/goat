export function browserContextMenuPrefix(
  contents: Electron.WebContents,
  isBrowser: boolean,
): Electron.MenuItemConstructorOptions[] {
  if (!isBrowser) return [];
  return [
    {
      label: "Reload",
      click: () => {
        if (!contents.isDestroyed()) contents.reload();
      },
    },
    { type: "separator" },
  ];
}
