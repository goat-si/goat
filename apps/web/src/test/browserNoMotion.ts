// Browser tests assert on settled UI. Base UI keeps a closing dialog or tooltip mounted until its
// CSS transition or animation ends, and on a loaded CI runner a 200 ms close can outlast
// vi.waitFor's 1 s default. Zero durations let those popups unmount on the next frame, as
// RightPanelTabs and WelcomeWizard tests already arrange by stubbing getAnimations.
const style = document.createElement("style");
style.dataset.testNoMotion = "";
style.textContent = [
  "*, *::before, *::after {",
  "  transition-duration: 0s !important;",
  "  transition-delay: 0s !important;",
  "  animation-duration: 0s !important;",
  "  animation-delay: 0s !important;",
  "}",
].join("\n");
document.head.append(style);
