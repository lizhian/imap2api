import { afterEach, describe, expect, it, vi } from "vitest";
import { DownloadCancelledError, DownloadLimiter } from "./download-limiter.js";

afterEach(() => vi.useRealTimers());

describe("DownloadLimiter", () => {
  it("queues requests in FIFO order and responds to a higher runtime limit", async () => {
    let limit = 1;
    const limiter = new DownloadLimiter(() => limit);
    const firstRelease = await limiter.acquire();
    const order: string[] = [];
    const second = limiter.acquire().then((release) => { order.push("second"); return release; });
    const third = limiter.acquire().then((release) => { order.push("third"); return release; });

    await Promise.resolve();
    expect(order).toEqual([]);
    limit = 2;
    limiter.refresh();
    const secondRelease = await second;
    expect(order).toEqual(["second"]);
    secondRelease();
    const thirdRelease = await third;
    expect(order).toEqual(["second", "third"]);

    firstRelease();
    thirdRelease();
    limiter.stop();
  });

  it("times out queued requests after 30 seconds", async () => {
    vi.useFakeTimers();
    const limiter = new DownloadLimiter(() => 1, 30_000, 50);
    const release = await limiter.acquire();
    const timedOut = limiter.acquire();
    const timeoutAssertion = expect(timedOut).rejects.toMatchObject({ statusCode: 429, code: "DOWNLOAD_QUEUE_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(30_000);
    await timeoutAssertion;
    release();
    limiter.stop();
  });

  it("cancels aborted waiters and caps the queue at 50", async () => {
    const limiter = new DownloadLimiter(() => 1, 30_000, 50);
    const release = await limiter.acquire();
    const controller = new AbortController();
    const aborted = limiter.acquire(controller.signal);
    controller.abort();
    await expect(aborted).rejects.toBeInstanceOf(DownloadCancelledError);

    const queued = Array.from({ length: 50 }, () => limiter.acquire());
    await expect(limiter.acquire()).rejects.toMatchObject({ statusCode: 429, code: "DOWNLOAD_QUEUE_FULL" });

    limiter.stop();
    await Promise.all(queued.map((request) => expect(request).rejects.toBeInstanceOf(DownloadCancelledError)));
    release();
  });
});
