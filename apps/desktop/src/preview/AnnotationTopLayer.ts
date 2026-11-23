export function mountAnnotationTopLayer(host: HTMLElement, shadowRoot: ShadowRoot): () => void {
  // Page popovers and modal dialogs sit in the top layer above any z-index, and a modal makes
  // everything outside it inert, so the overlay is shown last and lives inside the topmost modal.
  // Modals in the order they opened, since DOM order does not say which one blocks the rest.
  const openedModals: Element[] = [];
  const raiseOverlay = (): void => {
    const focused = shadowRoot.activeElement;
    const parent =
      document.activeElement?.closest("dialog:modal") ??
      openedModals.findLast((dialog) => dialog.matches(":modal")) ??
      Array.from(document.querySelectorAll("dialog:modal")).at(-1) ??
      document.documentElement;
    if (host.parentElement !== parent) parent.appendChild(host);
    if (host.matches(":popover-open")) host.hidePopover();
    host.showPopover();
    if (focused instanceof HTMLElement && !focused.matches(":focus"))
      focused.focus({ preventScroll: true });
  };
  const onPageToggle = (event: Event): void => {
    const target = event.target;
    if (target === host) return;
    if (target instanceof HTMLDialogElement) {
      const index = openedModals.indexOf(target);
      if (index !== -1) openedModals.splice(index, 1);
      if (target.matches(":modal")) openedModals.push(target);
    }
    raiseOverlay();
  };
  // Removing an open dialog hides the overlay inside it without a toggle event.
  const detachObserver = new MutationObserver(() => {
    if (!host.isConnected || !host.matches(":popover-open")) raiseOverlay();
  });

  raiseOverlay();
  window.addEventListener("toggle", onPageToggle, true);
  detachObserver.observe(document.documentElement, { childList: true, subtree: true });
  return () => {
    window.removeEventListener("toggle", onPageToggle, true);
    detachObserver.disconnect();
  };
}
