import { secondTick } from "@goat/client-runtime/clock";

// Update only the label on the shared clock; ref cleanup releases its subscription.
export function tickTextContent(format: (nowMs: number) => string, live: boolean) {
  return (node: HTMLElement | null) => {
    if (!node) return;
    const write = () => {
      const text = format(Date.now());
      if (node.textContent !== text) node.textContent = text;
    };
    write();
    return live ? secondTick.subscribe(write) : undefined;
  };
}
