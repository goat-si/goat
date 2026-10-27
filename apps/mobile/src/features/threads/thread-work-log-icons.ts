import type { AppSymbolName } from "../../components/ui/AppSymbol";
import type { ThreadActivityIcon } from "../../lib/threadActivityIcons";

export function workRowSymbolName(
  icon: ThreadActivityIcon,
): AppSymbolName | "browser" | "computer" {
  switch (icon) {
    case "agent":
      return { ios: "sparkles", android: "auto_awesome" };
    case "alert":
      return { ios: "exclamationmark.triangle", android: "error" };
    case "browser":
      return { ios: "safari", android: "public" };
    case "check":
      return { ios: "checkmark", android: "check" };
    case "command":
      return { ios: "terminal", android: "terminal" };
    case "computer":
      return "computer";
    case "code":
      return "chevron.left.forwardslash.chevron.right";
    case "edit":
      return { ios: "square.and.pencil", android: "edit" };
    case "eye":
      return { ios: "eye", android: "visibility" };
    case "folder":
      return { ios: "folder", android: "folder" };
    case "globe":
      return { ios: "globe", android: "public" };
    case "search":
      return "magnifyingglass";
    case "stop":
      return "stop.fill";
    case "hammer":
      return { ios: "hammer", android: "construction" };
    case "lock":
      return { ios: "lock", android: "lock" };
    case "message":
      return { ios: "bubble.left", android: "chat_bubble" };
    case "warning":
      return { ios: "xmark", android: "close" };
    case "wrench":
      return { ios: "wrench", android: "build" };
    case "zap":
      return { ios: "bolt", android: "bolt" };
  }
}
