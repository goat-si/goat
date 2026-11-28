// Lifted from GOAT v1 apps/desktop/src/window/DesktopApplicationMenu.ts (adapted): same template,
// order, labels and accelerators, without the items whose features GOAT 2 does not have yet
// (Check for Updates, Settings..., Paste as Text, "Let GOAT Use a Browser Tab…"). v1's
// "Server recovery..." is "Start Host" here: it leaves the host's crash-loop pause.
import { Menu, webContents, type MenuItemConstructorOptions } from "electron";

export type MainWindowZoomDirection = "in" | "out" | "reset";
export type MainWindowContentsCommand = "reload" | "forceReload" | "toggleDevTools";

export interface DesktopApplicationMenuActions {
  readonly displayName: string;
  readonly platform: NodeJS.Platform;
  readonly startHost: () => void;
  readonly zoomMain: (direction: MainWindowZoomDirection) => void;
  readonly runMainContentsCommand: (command: MainWindowContentsCommand) => void;
}

export function buildApplicationMenuTemplate(
  actions: DesktopApplicationMenuActions,
): MenuItemConstructorOptions[] {
  const { displayName, platform } = actions;
  const zoomClick = (direction: MainWindowZoomDirection) => () => actions.zoomMain(direction);
  const mainContentsClick = (command: MainWindowContentsCommand) => () =>
    actions.runMainContentsCommand(command);
  const template: MenuItemConstructorOptions[] = [];

  if (platform === "darwin") {
    template.push({
      label: displayName,
      submenu: [
        { role: "about", label: `About ${displayName}` },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide", label: `Hide ${displayName}` },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit", label: `Quit ${displayName}` },
      ],
    });
  }

  template.push(
    {
      label: "File",
      submenu: [
        { label: "Start Host", click: actions.startHost },
        {
          label: "Close Developer Tools",
          accelerator: "CmdOrCtrl+W",
          visible: false,
          click: () => {
            webContents
              .getAllWebContents()
              .find((contents) => !contents.isDestroyed() && contents.isDevToolsFocused())
              ?.closeDevTools();
          },
        },
        // Cmd/Ctrl+W belongs to the renderer's tab close; it must never close the window.
        platform === "darwin"
          ? { label: "Close Window", click: (_item, window) => window?.close() }
          : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "delete" },
        { type: "separator" },
        { role: "selectAll" },
        ...(platform === "darwin"
          ? [
              { type: "separator" as const },
              {
                label: "Speech",
                submenu: [{ role: "startSpeaking" as const }, { role: "stopSpeaking" as const }],
              },
            ]
          : []),
      ],
    },
    {
      label: "View",
      submenu: [
        /* Native reload/DevTools/zoom roles target focused guests; these commands must target the app. */
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: mainContentsClick("reload") },
        {
          label: "Force Reload",
          accelerator: "Shift+CmdOrCtrl+R",
          click: mainContentsClick("forceReload"),
        },
        {
          label: "Toggle Developer Tools",
          accelerator: platform === "darwin" ? "Alt+Command+I" : "Ctrl+Shift+I",
          click: mainContentsClick("toggleDevTools"),
        },
        { type: "separator" },
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: zoomClick("reset") },
        { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: zoomClick("in") },
        {
          label: "Zoom In",
          accelerator: "CmdOrCtrl+Plus",
          visible: false,
          click: zoomClick("in"),
        },
        ...(platform === "darwin"
          ? [
              {
                label: "Zoom In",
                accelerator: "CmdOrCtrl+Shift+=",
                visible: false,
                click: zoomClick("in"),
              },
            ]
          : []),
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: zoomClick("out") },
        // Keypad codes do not match number-row accelerators.
        {
          label: "Actual Size",
          accelerator: "CmdOrCtrl+num0",
          visible: false,
          click: zoomClick("reset"),
        },
        {
          label: "Zoom In",
          accelerator: "CmdOrCtrl+numadd",
          visible: false,
          click: zoomClick("in"),
        },
        {
          label: "Zoom Out",
          accelerator: "CmdOrCtrl+numsub",
          visible: false,
          click: zoomClick("out"),
        },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      // Electron's default Window submenu adds a Ctrl+W close role off macOS.
      role: "windowMenu",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(platform === "darwin" ? [{ type: "separator" as const }, { role: "front" as const }] : []),
      ],
    },
  );
  return template;
}

export function configureApplicationMenu(actions: DesktopApplicationMenuActions): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenuTemplate(actions)));
}
