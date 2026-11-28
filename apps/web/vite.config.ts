import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { v1Aliases } from "./vite-plugin-v1.ts";

export default defineConfig({ plugins: [v1Aliases(fileURLToPath(new URL(".", import.meta.url))), react()], server: { port: 5733 } });
