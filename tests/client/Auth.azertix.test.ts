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
});
