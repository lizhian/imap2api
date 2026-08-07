import { resolve } from "node:path";

export interface AppConfig {
  token: string;
  dataDir: string;
  databasePath: string;
  host: string;
  port: number;
  initialPollIntervalSeconds: number;
  webDistPath: string;
}

export function loadConfig(env = process.env): AppConfig {
  const token = env.IMAP2API_TOKEN ?? "";
  if (token.length < 32) {
    throw new Error("IMAP2API_TOKEN is required and must contain at least 32 characters");
  }

  const dataDir = resolve(env.IMAP2API_DATA_DIR ?? "/data");
  const port = Number(env.PORT ?? 3000);
  const intervalSeconds = Number(env.SYNC_INTERVAL_SECONDS ?? 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port");
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 5 || intervalSeconds > 3600) throw new Error("SYNC_INTERVAL_SECONDS must be between 5 and 3600");

  return {
    token,
    dataDir,
    databasePath: resolve(dataDir, "imap2api.db"),
    host: env.HOST ?? "0.0.0.0",
    port,
    initialPollIntervalSeconds: intervalSeconds,
    webDistPath: resolve(env.IMAP2API_WEB_DIST ?? new URL("../../web/dist", import.meta.url).pathname)
  };
}
