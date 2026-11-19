import * as Dialog from "../components/ui/Dialog";
import { threadOutboxManager } from "./thread-outbox";

export function loadThreadOutbox(isActive: () => boolean): void {
  void threadOutboxManager.load().then((loaded) => {
    if (loaded || !isActive()) return;
    Dialog.alert(
      "Some queued messages could not be loaded",
      "Unreadable records and attachment files are still saved. Other messages can still be sent.",
      [
        { text: "Dismiss", style: "cancel" },
        { text: "Retry", onPress: () => loadThreadOutbox(isActive) },
      ],
    );
  });
}
