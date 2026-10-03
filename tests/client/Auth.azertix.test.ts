import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPlayToken } from "../../src/client/Auth";
const descriptor = Object.getOwnPropertyDescriptor(window, "location")!;
let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  (window as any).BOOTSTRAP_CONFIG = { platformApiBase: "/platform-api" };
  assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      origin: "https://openfront.test",
      href: "https://openfront.test/",
      assign,
    },
  });
  localStorage.setItem(
    "player_persistent_id",
    "12345678-1234-4234-8234-1234567890ab",
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })),
  );
});
afterEach(() => {
  Object.defineProperty(window, "location", descriptor);
  localStorage.clear();
  vi.unstubAllGlobals();
  delete (window as any).BOOTSTRAP_CONFIG;
});
describe("Azertix solo and multiplayer authentication", () => {
  it("starts a local game without Discord or an API round trip", async () => {
    expect(await getPlayToken(true)).toBe(
      "12345678-1234-4234-8234-1234567890ab",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
  it("refuses a guest identity for multiplayer and requests Discord login", async () => {
    await expect(getPlayToken()).rejects.toThrow();
    expect(assign).toHaveBeenCalledWith("/login");
  });
  it("requests a signed ticket for the current code room", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jwt: "signed-room-ticket" }),
    } as Response);
    expect(await getPlayToken(false, "a123456789")).toBe("signed-room-ticket");
    expect(fetch).toHaveBeenCalledWith(
      "https://openfront.test/platform-api/auth/play-token",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ gameId: "a123456789" }),
      }),
    );
    expect(assign).not.toHaveBeenCalled();
  });
  it("requests the code form when a room grant is absent", async () => {
    await expect(getPlayToken(false, "a123456789")).rejects.toThrow();
    expect(assign).toHaveBeenCalledWith("/login?join=1");
  });
});
