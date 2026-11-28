import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
// v1 CSS scoped to [data-v1] (postcss.config.js); loaded with the app so the bot-home baselines prove it leaks nothing.
import "./v1/seam/v1-entry.css";
import { App } from "./App.tsx";
import { HostProvider, createHostFromLocation } from "./host/HostProvider.tsx";
import { UiStore } from "./ui-state/uiState.ts";
import { sceneUi } from "./scenes.ts";

const host = createHostFromLocation();
const scene = new URLSearchParams(location.search).get("fake");
const ui = new UiStore(scene ? sceneUi(scene) : {}, scene ? null : host.client.getSnapshot().demo ? "goat2.demo.ui.v1" : "goat2.ui.v1");

if (scene === "12P-1") host.client.sendMessage({ botId: "reviewer", threadId: "t-reviewer" }, "#7712: if the list comes back empty, keep the previous list", "followup");

const rootEl = document.getElementById("root")!;
if (new URLSearchParams(location.search).has("v1fixture")) {
  // CSS scoping / portal fixture for e2e/v1fixture.spec.ts.
  void import("@v1/surfaces").then(({ V1Fixture }) => createRoot(rootEl).render(<V1Fixture />));
} else {
  createRoot(rootEl).render(
    <StrictMode>
      <HostProvider value={host}>
        <App ui={ui} scene={scene} />
      </HostProvider>
    </StrictMode>,
  );
}
