import type { ApiError } from "@imap2api/shared";

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
}
