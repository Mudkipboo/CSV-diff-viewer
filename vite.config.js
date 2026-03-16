import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// VITE_BASE_PATH is set by the GitHub Actions deploy workflow to match
// the repo name (e.g. /sql-snapshot-diff/). Locally it defaults to /.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH || "/",
});
