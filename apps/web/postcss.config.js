// Tailwind 4 for the lifted v1 tree, then scope its output to [data-v1] (devlog 070 Revision A2.3). GOAT 2's own CSS
// (src/app.css) has no Tailwind directives and is outside src/v1, so both steps leave it as written.
import tailwindcss from "@tailwindcss/postcss";
import prefixSelector from "postcss-prefix-selector";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scopeV1Selector } from "./v1-css-scope.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  plugins: [
    // base: Tailwind's automatic source detection scans only the v1 tree, so GOAT 2 class names never become utilities.
    tailwindcss({ base: path.join(here, "src/v1") }),
    prefixSelector({ prefix: "[data-v1]", includeFiles: [/[\\/]src[\\/]v1[\\/]/], transform: scopeV1Selector }),
  ],
};
