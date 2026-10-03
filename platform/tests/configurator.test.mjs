import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import catalog from "../../platform/public/maps.json";
import { openRoomConfigurator } from "../../platform/public/room-config.js";
import {
  NativeSettingsSchema,
  nativeToRoomInput,
  roomGameConfig,
  RoomInputSchema,
  TournamentInputSchema,
} from "../../platform/room-config.mjs";
import { maps } from "../../src/core/game/Maps.gen";
import { GameConfigSchema } from "../../src/core/Schemas";

// Exercises the actual rendered form and native wire contract, rather than
// mirroring the controls: maps/teams/options must survive into engine settings.
beforeEach(() => {
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
  it("tournament settings use the native contract and cannot inject a roster or solo game", () => {
    const config = NativeSettingsSchema.parse({
      gameMap: "Japan",
      gameType: "Private",
      gameMode: "Team",
      playerTeams: "Duos",
      bots: 50,
      goldMultiplier: 2.5,
      startingGold: 500000,
    });
    const tournament = TournamentInputSchema.parse({
      name: "Tournament",
      startsAt: "2026-10-05T18:00:00Z",
      capacity: 24,
      rounds: 3,
      gameConfig: config,
    });
    expect(
      roomGameConfig(
        RoomInputSchema.parse(
          nativeToRoomInput(
            tournament.gameConfig,
            "Configuration",
            tournament.capacity,
          ),
        ),
      ),
    ).toMatchObject({
      gameMap: "Japan",
      maxPlayers: 24,
      playerTeams: "Duos",
      startingGold: 500000,
      goldMultiplier: 2.5,
      gameType: "Private",
    });
    for (const extra of [
      { allowedPublicIds: ["intruder"] },
      { gameType: "Singleplayer" },
      { listed: true },
      { trusted: true },
      { gameMap: "Unknown" },
      {
        gameMode: "Team",
        playerTeams: "Humans Vs Nations",
        nations: "disabled",
      },
    ]) {
      expect(
        NativeSettingsSchema.safeParse({ ...config, ...extra }).success,
      ).toBe(false);
    }
  });
  it("accepts only the matching native frame and preserves settings for both creation flows", async () => {
    for (const kind of ["room", "tournament"]) {
      const create = vi.fn().mockResolvedValue({});
      const onCreated = vi.fn();
      await openRoomConfigurator({ kind, create, onCreated, notice: vi.fn() });
      change("name", "Native configuration validation");
      change("capacity", "12");
      if (kind === "tournament") {
        change("startsAt", "2026-10-05T20:00");
        change("rounds", "3");
      }
      const frame = document.querySelector("iframe");
      const requestId = new URL(frame.src).searchParams.get(
        "configurationRequest",
      );
      const config = {
        gameMap: "Japan",
        gameType: "Private",
        gameMode: "Team",
        playerTeams: "Duos",
        bots: 50,
        nations: "default",
        difficulty: "Hard",
        gameMapSize: "Compact",
        instantBuild: true,
        startingGold: 500000,
        goldMultiplier: 2.5,
      };
      const data = { type: "openfront-game-config", requestId, config };
      for (const forged of [
        {
          origin: "https://attacker.example",
          source: frame.contentWindow,
          data,
        },
        { origin: location.origin, source: window, data },
        {
          origin: location.origin,
          source: frame.contentWindow,
          data: { ...data, requestId: "wrong-request" },
        },
      ])
        window.dispatchEvent(new MessageEvent("message", forged));
      expect(create).not.toHaveBeenCalled();
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: location.origin,
          source: frame.contentWindow,
          data,
        }),
      );
      await vi.waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
      const input = create.mock.calls[0][0];
      const settings =
        kind === "room"
          ? RoomInputSchema.parse(input)
          : RoomInputSchema.parse(
              nativeToRoomInput(
                NativeSettingsSchema.parse(input.gameConfig),
                "Configuration",
                input.capacity,
              ),
            );
      expect(roomGameConfig(settings)).toMatchObject({
        gameMap: "Japan",
        gameMode: "Team",
        playerTeams: "Duos",
        maxPlayers: 12,
        instantBuild: true,
        startingGold: 500000,
        goldMultiplier: 2.5,
      });
    }
  });
  it("a rejected save remains editable and cannot create twice during a pending request", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("Échec serveur"))
      .mockResolvedValue({});
    await openRoomConfigurator({ create, onCreated: vi.fn(), notice: vi.fn() });
    change("name", "Retry validation");
    const frame = document.querySelector("iframe");
    const event = () =>
      new MessageEvent("message", {
        origin: location.origin,
        source: frame.contentWindow,
        data: {
          type: "openfront-game-config",
          requestId: new URL(frame.src).searchParams.get(
            "configurationRequest",
          ),
          config: { gameMap: "World", gameType: "Private" },
        },
      });
    window.dispatchEvent(event());
    window.dispatchEvent(event());
    await vi.waitFor(() =>
      expect(document.querySelector("[data-error]").textContent).toBe(
        "Échec serveur",
      ),
    );
    expect(create).toHaveBeenCalledOnce();
    expect(frame.hasAttribute("inert")).toBe(false);
    window.dispatchEvent(event());
    await vi.waitFor(() => expect(document.querySelector("dialog")).toBeNull());
  });
});
