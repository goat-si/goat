import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
import "./v1/v1.css";
import { Preview } from "./v1/Preview.tsx";
import { App } from "./App.tsx";
import { HostProvider, createHostFromLocation } from "./host/HostProvider.tsx";
import { UiStore } from "./ui-state/uiState.ts";
import { sceneUi } from "./scenes.ts";

const host = createHostFromLocation();
const scene = new URLSearchParams(location.search).get("fake");
const ui = new UiStore(scene ? sceneUi(scene) : {}, scene ? null : host.client.getSnapshot().demo ? "goat2.demo.ui.v1" : "goat2.ui.v1");

if (scene === "12P-1") host.client.sendMessage({ botId: "reviewer", threadId: "t-reviewer" }, "#7712: if the list comes back empty, keep the previous list", "followup");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {new URLSearchParams(location.search).has("v1preview") ? <Preview /> : <HostProvider value={host}>
      <App ui={ui} scene={scene} />
    </HostProvider>}
  </StrictMode>,
);
