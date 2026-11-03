import { cuaAppKey } from "@goat/shared/cuaDriverManifest";
import type { ComputerUseApp } from "@goat/contracts";

const terminals = new Set([
  "com.apple.terminal",
  "com.googlecode.iterm2",
  "dev.warp.warp-stable",
  "com.mitchellh.ghostty",
  "net.kovidgoyal.kitty",
  "org.alacritty",
  "com.github.wez.wezterm",
  "co.zeit.hyper",
  "org.tabby",
  "org.gnome.terminal",
  "org.gnome.console",
  "org.gnome.ptyxis",
  "org.kde.konsole",
  "org.wezfurlong.wezterm",
  "microsoft.windowsterminal",
  "terminal",
  "iterm",
  "iterm2",
  "warp",
  "ghostty",
  "kitty",
  "alacritty",
  "wezterm",
  "wezterm-gui",
  "hyper",
  "tabby",
  "gnome-terminal",
  "gnome terminal",
  "console",
  "windows terminal",
  "windows powershell",
  "command prompt",
  "gnome-terminal-server",
  "kgx",
  "ptyxis",
  "konsole",
  "xterm",
  "xfce4-terminal",
  "tilix",
  "terminator",
  "foot",
  "urxvt",
  "st",
  "warp-terminal",
  "windowsterminal",
  "wt",
  "powershell",
  "pwsh",
  "cmd",
  "conhost",
  "openconsole",
]);

const isTerminalCuaApplication = (app: string): boolean => {
  const key = cuaAppKey(app);
  const basename = key
    .split(/[\\/]/u)
    .at(-1)
    ?.toLowerCase()
    .replace(/\.exe$/u, "");
  return (
    terminals.has(key) ||
    /^microsoft\.windowsterminal_[^!\\/]+!app$/u.test(key) ||
    (basename !== undefined && terminals.has(basename))
  );
};

export const isTerminalCuaApplicationInCatalog = (
  app: string,
  catalog: ReadonlyArray<ComputerUseApp>,
): boolean =>
  isTerminalCuaApplication(app) ||
  catalog.some((entry) => {
    const identities = [entry.id, entry.name, ...(entry.executables ?? [])];
    return (
      identities.some((identity) => cuaAppKey(identity) === cuaAppKey(app)) &&
      identities.some(isTerminalCuaApplication)
    );
  });
