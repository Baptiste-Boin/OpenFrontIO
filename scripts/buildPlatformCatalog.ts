import fs from "node:fs/promises";
import { maps } from "../src/core/game/Maps.gen";

const translations = JSON.parse(
  await fs.readFile("resources/lang/fr.json", "utf8"),
);
const catalog = [...maps]
  .sort(
    (a, b) =>
      (a.featuredRank ?? 1000) - (b.featuredRank ?? 1000) ||
      a.type.localeCompare(b.type, "en"),
  )
  .map((map) => ({
    value: map.type,
    label: translations.map?.[map.translationKey.split(".")[1]] ?? map.type,
    thumbnail: `/maps/${map.id.toLowerCase()}/thumbnail.webp`,
    categories: map.categories,
    nations: map.defaultNationCount,
  }));
await fs.writeFile(
  "platform/public/maps.json",
  JSON.stringify(catalog, null, 2) + "\n",
);
