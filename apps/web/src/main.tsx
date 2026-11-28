import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BotHome } from "./bot-home/BotHome.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BotHome />
  </StrictMode>,
);
