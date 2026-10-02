import { z } from "zod";
import roomMaps from "./public/maps.json" with { type: "json" };
export { roomMaps };
export const roomUnits = [
  "City",
  "Defense Post",
  "Port",
  "Warship",
  "Transport",
  "Missile Silo",
  "SAM Launcher",
  "Atom Bomb",
  "Hydrogen Bomb",
  "MIRV",
  "Factory",
];
export const RoomInputSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    capacity: z.number().int().min(2).max(200).default(20),
    map: z.enum(roomMaps.map((map) => map.value)).default("World"),
    bots: z.number().int().min(0).max(400).default(100),
    nations: z
      .union([
        z.literal("disabled"),
        z.literal("default"),
        z.number().int().min(1).max(400),
      ])
      .default("default"),
    gameMode: z.enum(["Free For All", "Team"]).default("Free For All"),
    playerTeams: z
      .union([
        z.number().int().min(2).max(100),
        z.enum(["Duos", "Trios", "Quads", "Humans Vs Nations"]),
      ])
      .default(2),
    difficulty: z
      .enum(["Easy", "Medium", "Hard", "Impossible"])
      .default("Easy"),
    gameMapSize: z.enum(["Normal", "Compact"]).default("Normal"),
    randomSpawn: z.boolean().default(false),
    infiniteGold: z.boolean().default(false),
    infiniteTroops: z.boolean().default(false),
    instantBuild: z.boolean().default(false),
    donateGold: z.boolean().default(true),
    donateTroops: z.boolean().default(true),
    waterNukes: z.boolean().default(false),
    disabledUnits: z.array(z.enum(roomUnits)).max(roomUnits.length).default([]),
    maxTimerValue: z.number().int().min(1).max(120).nullable().default(null),
    customAllianceDuration: z
      .number()
      .int()
      .min(0)
      .max(15)
      .nullable()
      .default(null),
    goldMultiplier: z.number().min(0.1).max(1000).default(1),
    startingGold: z.number().int().min(0).max(1000000000).default(0),
    doomsdayClock: z
      .object({
        enabled: z.boolean(),
        speed: z.enum(["slow", "normal", "fast", "veryfast"]),
      })
      .strict()
      .default({ enabled: false, speed: "normal" }),
    overtime: z
      .object({
        enabled: z.boolean(),
        startMinutes: z.number().int().min(1).max(120),
      })
      .strict()
      .default({ enabled: false, startMinutes: 30 }),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (
      input.gameMode === "Team" &&
      input.playerTeams === "Humans Vs Nations" &&
      (input.nations === "disabled" ||
        roomMaps.find((map) => map.value === input.map)?.nations === 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Choisis une carte avec des nations et active-les pour Humains contre nations",
        path: ["nations"],
      });
    }
  });

export function roomGameConfig(input) {
  const { capacity, map, playerTeams, ...settings } = input;
  delete settings.name;
  return {
    ...settings,
    gameMap: map,
    gameType: "Private",
    maxPlayers: capacity,
    ...(settings.gameMode === "Team" ? { playerTeams } : {}),
    donateGold: settings.gameMode === "Team" && settings.donateGold,
    donateTroops: settings.gameMode === "Team" && settings.donateTroops,
    listed: false,
    featured: false,
  };
}

// Tournaments use the same settings whitelist as code rooms. Access control
// (capacity, private visibility and roster) is set by the platform, never by
// arbitrary native-editor fields supplied by the browser.
const nativeSettings = { ...RoomInputSchema.shape };
delete nativeSettings.name;
delete nativeSettings.capacity;
delete nativeSettings.map;
export const NativeSettingsSchema = z
  .object({
    ...nativeSettings,
    gameMap: RoomInputSchema.shape.map,
    gameType: z.literal("Private").optional(),
    maxPlayers: z.number().int().min(2).max(200).optional(),
    listed: z.literal(false).optional(),
    featured: z.literal(false).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const result = RoomInputSchema.safeParse(
      nativeToRoomInput(input, "Configuration", 20),
    );
    if (!result.success)
      for (const issue of result.error.issues) ctx.addIssue(issue);
  });

export function nativeToRoomInput(config, name, capacity) {
  const settings = { ...config };
  for (const key of ["gameMap", "gameType", "maxPlayers", "listed", "featured"])
    delete settings[key];
  return { ...settings, name, capacity, map: config.gameMap };
}

export const TournamentInputSchema = z
  .object({
    name: z.string().trim().min(3).max(120),
    startsAt: z.iso.datetime(),
    capacity: z.number().int().min(2).max(200),
    rounds: z.number().int().min(1).max(20),
    rules: z.string().max(5000).default(""),
    gameConfig: NativeSettingsSchema.default({}),
  })
  .strict();
