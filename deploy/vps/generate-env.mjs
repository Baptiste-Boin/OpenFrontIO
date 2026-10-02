import { generateKeyPairSync, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
const url = new URL(process.argv[2] ?? "https://openfront.azertixyt.fr");
if (url.protocol !== "https:") throw new Error("HTTPS required");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const secret = () => randomBytes(32).toString("hex");
const values = {
  APP_URL: url.origin,
  DOMAIN: url.hostname,
  POSTGRES_PASSWORD: secret(),
  SESSION_SECRET: secret(),
  JWT_PRIVATE_KEY: Buffer.from(
    privateKey.export({ type: "pkcs8", format: "pem" }),
  ).toString("base64"),
  JWT_PUBLIC_KEY: Buffer.from(
    publicKey.export({ type: "spki", format: "pem" }),
  ).toString("base64"),
  API_KEY: secret(),
  ADMIN_BOT_API_KEY: secret(),
  DISCORD_CLIENT_ID: "",
  DISCORD_CLIENT_SECRET: "",
  DISCORD_GUILD_ID: "",
  ADMIN_DISCORD_IDS: "",
  DISCORD_BOT_TOKEN: "",
  DISCORD_ANNOUNCEMENT_CHANNEL_ID: "",
};
writeFileSync(
  "/srv/openfront/.env",
  Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n",
  { mode: 0o600, flag: "wx" },
);
console.log("Secrets generated in /srv/openfront/.env");
