import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import catalog from "../../platform/public/maps.json";
import { openRoomConfigurator } from "../../platform/public/room-config.js";
import {
  roomGameConfig,
  RoomInputSchema,
} from "../../platform/room-config.mjs";
import { maps } from "../../src/core/game/Maps.gen";
import { GameConfigSchema } from "../../src/core/Schemas";

// Exercises the actual rendered form and native wire contract, rather than
// mirroring the controls: maps/teams/options must survive into engine settings.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => ({
      ok: true,
      json: async () =>
        url === "/asset-manifest.json"
          ? Object.fromEntries(
              catalog.map((map) => [
                map.thumbnail.slice(1),
                map.thumbnail
                  .replace("/maps/", "/_assets/maps/")
                  .replace("thumbnail.webp", "thumbnail.testhash.webp"),
              ]),
            )
          : catalog,
    })),
  );
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
const field = (name) => document.querySelector(`[name="${name}"]`);
const change = (name, value) => {
  field(name).value = value;
  field(name).dispatchEvent(new Event("change", { bubbles: true }));
};
const check = (name, checked = true) => {
  const element = field(name);
  element.checked = checked;
  element.dispatchEvent(new Event("change", { bubbles: true }));
};
const submit = () =>
  document
    .querySelector("form")
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const click = (selector) => document.querySelector(selector).click();

describe("private room configuration", () => {
  it("catalog covers every native map with its real thumbnail and nation count", () => {
    expect(catalog.map((m) => m.value).sort()).toEqual(
      maps.map((m) => m.type).sort(),
    );
    for (const map of maps) {
      expect(catalog.find((m) => m.value === map.type)).toMatchObject({
        thumbnail: `/maps/${map.id.toLowerCase()}/thumbnail.webp`,
        nations: map.defaultNationCount,
      });
      const config = roomGameConfig(
        RoomInputSchema.parse({ name: "Map validation", map: map.type }),
      );
      expect(GameConfigSchema.partial().safeParse(config).success).toBe(true);
    }
  });
  it.each([2, 3, 4, 5, 6, 7, 8, "Duos", "Trios", "Quads", "Humans Vs Nations"])(
    "team format %s is accepted by the game schema",
    (playerTeams) => {
      const config = roomGameConfig(
        RoomInputSchema.parse({
          name: "Team validation",
          gameMode: "Team",
          playerTeams,
        }),
      );
      expect(GameConfigSchema.partial().parse(config).playerTeams).toBe(
        playerTeams,
      );
      expect(config.donateGold).toBe(true);
    },
  );
  it("rejects injected access settings, unknown maps, unsafe values and impossible nations mode", () => {
    for (const value of [
      { trusted: true },
      { listed: true },
      { allowedPublicIds: ["intruder"] },
      { map: "Unknown" },
      { bots: 401 },
      { capacity: 201 },
      { playerTeams: 0 },
      { startingGold: 1000000001 },
      { goldMultiplier: 0 },
      { disabledUnits: ["Invalid"] },
      {
        gameMode: "Team",
        playerTeams: "Humans Vs Nations",
        nations: "disabled",
      },
    ]) {
      expect(
        RoomInputSchema.safeParse({ name: "Rejected settings", ...value })
          .success,
      ).toBe(false);
    }
  });
  it("submits defaults and advanced team options through the rendered form", async () => {
    const create = vi.fn().mockResolvedValue({});
    const onCreated = vi.fn();
    const notice = vi.fn();
    await openRoomConfigurator({ create, onCreated, notice });
    expect(document.querySelectorAll("[data-map]").length).toBe(maps.length);
    expect(document.querySelector("[data-preview]").getAttribute("src")).toBe(
      "/_assets/maps/world/thumbnail.testhash.webp",
    );
    change("name", "Interface validation");
    click('[data-map="Japan"]');
    click('[data-mode="Team"]');
    change("playerTeams", "Duos");
    change("difficulty", "Hard");
    change("gameMapSize", "Compact");
    change("nations", "custom");
    change("nationCount", "12");
    change("bots", "50");
    check("randomSpawn");
    check("infiniteGold");
    check("instantBuild");
    check("maxTimer");
    change("maxTimerValue", "45");
    change("allianceMode", "custom");
    change("customAllianceDuration", "0");
    check("doomsday");
    change("doomsdaySpeed", "fast");
    check("overtime");
    change("overtimeMinutes", "20");
    change("goldMultiplier", "2.5");
    change("startingGold", "500000");
    check("unit:Atom Bomb", false);
    check("unit:Hydrogen Bomb", false);
    submit();
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    const config = roomGameConfig(
      RoomInputSchema.parse(create.mock.calls[0][0]),
    );
    expect(config).toMatchObject({
      gameMap: "Japan",
      gameMapSize: "Compact",
      gameMode: "Team",
      playerTeams: "Duos",
      difficulty: "Hard",
      bots: 50,
      nations: 12,
      randomSpawn: true,
      infiniteGold: true,
      instantBuild: true,
      maxTimerValue: 45,
      customAllianceDuration: 0,
      goldMultiplier: 2.5,
      startingGold: 500000,
      disabledUnits: ["Atom Bomb", "Hydrogen Bomb"],
      doomsdayClock: { enabled: true, speed: "fast" },
      overtime: { enabled: true, startMinutes: 20 },
      listed: false,
      featured: false,
    });
    expect(GameConfigSchema.partial().safeParse(config).success).toBe(true);
  });
  it("search does not lose selection, solo means FFA and a rejected save stays editable", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("Échec serveur"))
      .mockResolvedValue({});
    await openRoomConfigurator({ create, onCreated: vi.fn(), notice: vi.fn() });
    click('[data-map="France"]');
    const search = document.querySelector("[data-search]");
    search.value = "Monde";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(field("map").value).toBe("France");
    change("name", "Retry validation");
    submit();
    await vi.waitFor(() =>
      expect(document.querySelector("[data-error]").textContent).toBe(
        "Échec serveur",
      ),
    );
    expect(document.querySelector('[type="submit"]').disabled).toBe(false);
    const config = roomGameConfig(
      RoomInputSchema.parse(create.mock.calls[0][0]),
    );
    expect(config.gameMode).toBe("Free For All");
    expect(config).not.toHaveProperty("playerTeams");
    expect(config.donateTroops).toBe(false);
    submit();
    await vi.waitFor(() => expect(document.querySelector("dialog")).toBeNull());
  });
});
