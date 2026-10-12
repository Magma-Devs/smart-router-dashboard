import { ConfigurationService } from "./services/configuration.js";

// Run as the API's actual container user, before starting an installation.
// Never print source YAML, endpoint credentials, or parser exception text.
const result = new ConfigurationService().getConfiguration();
console.log(
  JSON.stringify({ configuration: result.configuration, routers: result.routers.length }),
);
if (result.configuration?.status !== "ready" && result.configuration?.status !== "empty") {
  process.exitCode = 1;
}
