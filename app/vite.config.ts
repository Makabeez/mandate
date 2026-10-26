import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Two pages: the dashboard (index.html, no bundled code of its own) and the
// agent chat (agent.html), which bundles the Aomi widget. `vite build` writes
// both to dist/, which is what gets served.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: { index: "index.html", agent: "agent.html" },
    },
  },
});
