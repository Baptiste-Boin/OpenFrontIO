import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GameModeSelector } from "../../src/client/GameModeSelector";
import { SinglePlayerModal } from "../../src/client/SinglePlayerModal";
import { GameMapType, GameMode, GameType } from "../../src/core/game/Game";
import { GameConfigSchema } from "../../src/core/Schemas";

vi.mock("../../src/client/Cosmetics", () => ({
  getPlayerCosmetics: vi.fn(),
  prewarmCosmetics: vi.fn(),
}));
vi.mock("../../src/client/TerrainMapFileLoader", () => ({
  terrainMapFileLoader: {
    getMapData: vi.fn(() => ({
      manifest: vi.fn(async () => ({
        nations: Array.from({ length: 12 }, () => ({})),
      })),
    })),
  },
}));
const original = window.BOOTSTRAP_CONFIG;
afterEach(() => {
  window.BOOTSTRAP_CONFIG = original;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function platform() {
  window.BOOTSTRAP_CONFIG = {
    ...original,
    platformApiBase: "/platform-api",
  } as typeof original;
}

describe("platform configuration and disabled solo", () => {
  it("blocks modal, direct solo start and tutorial while keeping the native editor available", async () => {
    platform();
    const modal = new SinglePlayerModal();
    const joins = vi.fn();
    const native = vi.fn();
    modal.addEventListener("join-lobby", joins);
    modal.addEventListener("game-config-selected", native);
    modal.open();
    expect(modal.isOpen()).toBe(false);
    await (modal as any).startGame();
    await modal.startTutorial();
    expect(joins).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
    modal.configurationOnly = true;
    await (modal as any).startGame();
    expect(native).toHaveBeenCalledOnce();
    expect((native.mock.calls[0][0] as CustomEvent).detail.gameType).toBe(
      GameType.Private,
    );
    expect(joins).not.toHaveBeenCalled();
  });
  it("actual native editor selection emits advanced private settings without starting a game", async () => {
    platform();
    const modal = new SinglePlayerModal();
    modal.configurationOnly = true;
    const internals = modal as any;
    internals.selectedMap = GameMapType.Japan;
    internals.handleConfigGameModeSelected(
      new CustomEvent("game-mode-selected", {
        detail: { mode: GameMode.Team },
      }),
    );
    internals.handleConfigTeamCountSelected(
      new CustomEvent("team-count-selected", { detail: { count: "Duos" } }),
    );
    internals.gameMode = GameMode.Team;
    internals.bots = 50;
    internals.nations = 12;
    internals.defaultNationCount = 30;
    internals.startingGold = true;
    internals.startingGoldValue = 5;
    internals.goldMultiplier = true;
    internals.goldMultiplierValue = 2;
    internals.maxTimer = true;
    internals.maxTimerValue = 45;
    internals.instantBuild = true;
    const selected = vi.fn();
    const joins = vi.fn();
    modal.addEventListener("game-config-selected", selected);
    modal.addEventListener("join-lobby", joins);
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const container = modal;
    modal.inline = true;
    document.body.append(modal);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    // Nation manifest initialization has settled before customization.
    internals.nations = 12;
    internals.defaultNationCount = 30;
    await modal.updateComplete;
    await (container.querySelector("game-config-settings") as any)
      .updateComplete;
    expect(container.querySelector("game-config-settings")).not.toBeNull();
    expect(container.textContent).not.toContain("single_modal.not_logged");
    // Editing the DOM without a blur reproduces the browser failure: the
    // visible values must win over the card's previous default values.
    await Promise.all(
      Array.from(
        container.querySelectorAll("toggle-input-card"),
        (card: any) => card.updateComplete,
      ),
    );
    (
      container.querySelector("#starting-gold-value") as HTMLInputElement
    ).value = "0.5";
    (
      container.querySelector("#gold-multiplier-value") as HTMLInputElement
    ).value = "2.5";
    expect(modal.confirmBeforeClose()).toBe(false);
    await internals.startGame();
    const config = (selected.mock.calls[0][0] as CustomEvent).detail;
    expect(GameConfigSchema.parse(config)).toMatchObject({
      gameType: "Private",
      gameMap: "Japan",
      gameMode: "Team",
      playerTeams: "Duos",
      bots: 50,
      nations: 12,
      startingGold: 500000,
      goldMultiplier: 2.5,
      maxTimerValue: 45,
      instantBuild: true,
    });
    expect(joins).not.toHaveBeenCalled();
  });
  it("player homepage keeps code entry and admin access, with no solo or tutorial cards", () => {
    platform();
    const selector = new GameModeSelector();
    const container = document.createElement("div");
    render(selector.render(), container);
    expect(container.querySelector('[name="code"]')).not.toBeNull();
    expect(container.querySelector('a[href="/admin"]')).not.toBeNull();
    expect(container.textContent).not.toContain("main.solo");
    expect(container.textContent).not.toContain("main.tutorial");
  });
});
