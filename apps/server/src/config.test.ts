import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("uses a 10 second initial polling interval", () => {
    expect(loadConfig({ IMAP2API_TOKEN: "t".repeat(32), IMAP2API_DATA_DIR: "/tmp/imap2api-config-test" }).initialPollIntervalSeconds).toBe(10);
  });

  it("rejects polling intervals outside the settings range", () => {
    expect(() => loadConfig({ IMAP2API_TOKEN: "t".repeat(32), SYNC_INTERVAL_SECONDS: "4" })).toThrow("between 5 and 3600");
    expect(() => loadConfig({ IMAP2API_TOKEN: "t".repeat(32), SYNC_INTERVAL_SECONDS: "3601" })).toThrow("between 5 and 3600");
  });
});
