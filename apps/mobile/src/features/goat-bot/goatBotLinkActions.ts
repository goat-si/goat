import { Alert } from "react-native";

import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";

/**
 * What a long press on a bot's link offers: the full address as the title, so a short label never
 * hides where it goes, and a way to open or copy it.
 */
export function showGoatBotLinkActions(url: string, open: () => void): void {
  Alert.alert(url, undefined, [
    { text: "Cancel", style: "cancel" },
    { text: "Copy link", onPress: () => void tryCopyTextWithHaptic(url, { target: "link" }) },
    { text: "Open link", onPress: open },
  ]);
}
