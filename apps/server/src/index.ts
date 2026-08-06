import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

try {
  const config = loadConfig();
  const app = await buildApp(config);
  await app.listen({ host: config.host, port: config.port });

  const shutdown = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
