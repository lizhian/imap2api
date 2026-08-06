import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";

afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); });

describe("App authentication", () => {
  it("keeps the token in session storage after verification", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    render(<App />);
    fireEvent.change(screen.getByLabelText("访问 Token"), { target: { value: "valid-token" } });
    fireEvent.click(screen.getByRole("button", { name: "进入管理" }));
    await waitFor(() => expect(sessionStorage.getItem("imap2api-token")).toBe("valid-token"));
  });

  it("shows a local error for an invalid token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { message: "Token 无效" } }) }));
    render(<App />);
    fireEvent.change(screen.getByLabelText("访问 Token"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "进入管理" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Token 无效");
  });
});
