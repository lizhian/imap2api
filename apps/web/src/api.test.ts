import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("ApiClient SSE", () => {
  it("parses events even when CRLF separators cross response chunks", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: ready\r\ndata: {\"serverTime\":\"2026-08-07T00:00:00.000Z\"}\r"));
        controller.enqueue(encoder.encode("\n\r\n"));
        controller.close();
      }
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, body }));
    const events: string[] = [];

    await expect(new ApiClient("token").subscribe((event) => events.push(event.type), new AbortController().signal))
      .rejects.toThrow("事件连接已断开");
    expect(events).toEqual(["ready"]);
  });
});
