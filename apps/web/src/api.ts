import type { ApiError, ServerEvent } from "@imap2api/shared";

export class ApiClient {
  constructor(private readonly token: string) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`/api/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers
      }
    });
    if (!response.ok && response.status !== 207) {
      const body = await response.json().catch(() => null) as ApiError | null;
      throw new Error(body?.error.message ?? `请求失败 (${response.status})`);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  async download(path: string, signal: AbortSignal, onStarted?: () => void): Promise<Blob> {
    const response = await fetch(`/api/v1${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as ApiError | null;
      throw new Error(body?.error.message ?? `附件下载失败 (${response.status})`);
    }
    onStarted?.();
    return response.blob();
  }

  async subscribe(onEvent: (event: ServerEvent) => void, signal: AbortSignal, accountId?: string): Promise<void> {
    const query = accountId ? `?accountId=${encodeURIComponent(accountId)}` : "";
    const response = await fetch(`/api/v1/events${query}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal
    });
    if (!response.ok || !response.body) throw new Error(`事件连接失败 (${response.status})`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = /\r?\n\r?\n/.exec(buffer);
      while (separator) {
        const block = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const eventName = block.split(/\r?\n/).find((line) => line.startsWith("event: "))?.slice(7);
        const data = block.split(/\r?\n/).filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
        if (eventName && data) onEvent({ ...JSON.parse(data), type: eventName } as ServerEvent);
        separator = /\r?\n\r?\n/.exec(buffer);
      }
    }
    if (!signal.aborted) throw new Error("事件连接已断开");
  }
}
