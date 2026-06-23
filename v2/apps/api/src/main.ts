import { buildApp } from "./app.js";
import { config } from "./config.js";

async function main() {
  const app = await buildApp();
  try {
    await app.listen({ port: config.server.port, host: config.server.host });
    app.log.info(`smart-router-dashboard api on :${config.server.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
