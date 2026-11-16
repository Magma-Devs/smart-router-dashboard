import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "auth-proxy",
    // Node's Request, Response and URL are the Worker's: @auth/core is written
    // to the web standard and runs on both unchanged.
    environment: "node",
  },
});
