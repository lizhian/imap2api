import { HttpError } from "./errors.js";

const DEFAULT_QUEUE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_QUEUE_SIZE = 50;

interface QueueEntry {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  timer: ReturnType<typeof setTimeout>;
  onAbort: () => void;
}

export class DownloadCancelledError extends Error {
  constructor() {
    super("附件下载已取消");
    this.name = "DownloadCancelledError";
  }
}

export class DownloadLimiter {
  private active = 0;
  private readonly queue: QueueEntry[] = [];
  private stopped = false;

  constructor(
    private readonly getLimit: () => number,
    private readonly queueTimeoutMs = DEFAULT_QUEUE_TIMEOUT_MS,
    private readonly maxQueueSize = DEFAULT_MAX_QUEUE_SIZE
  ) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.stopped) return Promise.reject(new DownloadCancelledError());
    if (signal?.aborted) return Promise.reject(new DownloadCancelledError());
    if (this.active < this.getLimit() && this.queue.length === 0) {
      this.active++;
      return Promise.resolve(this.releaseOnce());
    }
    if (this.queue.length >= this.maxQueueSize) {
      return Promise.reject(new HttpError(429, "DOWNLOAD_QUEUE_FULL", "附件下载队列已满，请稍后重试"));
    }
    return new Promise((resolve, reject) => {
      const entry: QueueEntry = {
        resolve,
        reject,
        signal,
        timer: setTimeout(() => {
          if (!this.remove(entry)) return;
          reject(new HttpError(429, "DOWNLOAD_QUEUE_TIMEOUT", "附件下载排队超时，请稍后重试"));
        }, this.queueTimeoutMs),
        onAbort: () => {
          if (!this.remove(entry)) return;
          reject(new DownloadCancelledError());
        }
      };
      entry.timer.unref();
      signal?.addEventListener("abort", entry.onAbort, { once: true });
      this.queue.push(entry);
      this.drain();
    });
  }

  refresh(): void {
    this.drain();
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.queue.splice(0)) {
      this.cleanupEntry(entry);
      entry.reject(new DownloadCancelledError());
    }
  }

  private drain(): void {
    while (!this.stopped && this.active < this.getLimit() && this.queue.length) {
      const entry = this.queue.shift()!;
      this.cleanupEntry(entry);
      if (entry.signal?.aborted) {
        entry.reject(new DownloadCancelledError());
        continue;
      }
      this.active++;
      entry.resolve(this.releaseOnce());
    }
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
    };
  }

  private remove(entry: QueueEntry): boolean {
    const index = this.queue.indexOf(entry);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    this.cleanupEntry(entry);
    return true;
  }

  private cleanupEntry(entry: QueueEntry): void {
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.onAbort);
  }
}
