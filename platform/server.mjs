import express from "express";
import { rateLimit } from "express-rate-limit";
import { exportJWK, importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createClient } from "redis";
import { z } from "zod";
import { startDiscordBot } from "./bot.mjs";
import {
  nativeToRoomInput,
  roomGameConfig,
  RoomInputSchema,
  TournamentInputSchema,
} from "./room-config.mjs";
import { registerRooms } from "./rooms.mjs";
import {
  cookie,
  decrypt,
  encrypt,
  equal,
  hash,
  isBanned,
  safeRedirect,
  scrubRecord,
  winningClients,
} from "./security.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
for (const name of [
  "APP_URL",
  "DATABASE_URL",
  "REDIS_URL",
  "SESSION_SECRET",
  "JWT_PRIVATE_KEY",
  "JWT_PUBLIC_KEY",
  "API_KEY",
  "ADMIN_BOT_API_KEY",
]) {
  if (!env[name]) throw new Error(`Missing ${name}`);
}
if (env.SESSION_SECRET.length < 32)
  throw new Error("SESSION_SECRET must have at least 32 characters");
const origin = new URL(env.APP_URL).origin;
const issuer = origin + "/platform-api";
const domain = new URL(origin).hostname;
const db = new pg.Pool({ connectionString: env.DATABASE_URL, max: 8 });
const redis = createClient({ url: env.REDIS_URL });
redis.on("error", () => console.error("Redis unavailable"));
await redis.connect();
const privateKey = await importPKCS8(
  Buffer.from(env.JWT_PRIVATE_KEY, "base64").toString(),
  "EdDSA",
);
const publicKey = await importSPKI(
  Buffer.from(env.JWT_PUBLIC_KEY, "base64").toString(),
  "EdDSA",
);
const jwk = {
  ...(await exportJWK(publicKey)),
  alg: "EdDSA",
  kid: "azertix-v1",
  use: "sig",
};
async function transaction(fn) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
await transaction(async (client) => {
  await client.query("SELECT pg_advisory_xact_lock(7341092)");
  await client.query(await fs.readFile(path.join(root, "schema.sql"), "utf8"));
});
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((req, res, next) => {
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
  });
  next();
});
app.use(
  rateLimit({
    windowMs: 60000,
    limit: 180,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }),
);
app.use(express.json({ limit: "5mb" }));
const fail = (status, message) => Object.assign(new Error(message), { status });
const uuid = z.uuid();
const parse = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) throw fail(400, "Paramètres invalides");
  return result.data;
};
const audit = (client, user, action, target) =>
  client.query("INSERT INTO audit_logs(actor,action,target) VALUES($1,$2,$3)", [
    user?.id ?? null,
    action,
    target,
  ]);
const bootstrapIds = (env.ADMIN_DISCORD_IDS ?? "").split(",").filter(Boolean);
const oauthReady = () =>
  Boolean(
    env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET && env.DISCORD_GUILD_ID,
  );
async function mint(user, guest = false, provider) {
  const sub = Buffer.from(user.id.replaceAll("-", ""), "hex").toString(
    "base64url",
  );
  const role = isBanned(user)
    ? "banned"
    : user.role === "SUPER_ADMIN"
      ? "root"
      : user.role === "TOURNAMENT_ADMIN"
        ? "admin"
        : user.role === "MODERATOR"
          ? "mod"
          : "player";
  return new SignJWT({
    role,
    provider:
      provider ??
      (guest
        ? "guest"
        : user.auth_provider === "owner"
          ? "owner"
          : user.auth_provider === "guest"
            ? "guest"
            : "discord"),
  })
    .setProtectedHeader({ alg: "EdDSA", kid: jwk.kid })
    .setSubject(sub)
    .setJti(crypto.randomUUID())
    .setIssuer(issuer)
    .setAudience(domain)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}
function sessionCookie(res, token, clear = false) {
  res.cookie("azertix_session", token, {
    httpOnly: true,
    secure: origin.startsWith("https:"),
    sameSite: "lax",
    path: "/",
    maxAge: clear ? 0 : 7 * 86400000,
  });
}
async function sessionUser(req) {
  const token = cookie(req, "azertix_session");
  if (!token) return null;
  const result = await db.query(
    "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()",
    [hash(token)],
  );
  return result.rows[0] ?? null;
}
async function auth(req, res, next) {
  req.user = await sessionUser(req);
  if (!req.user) throw fail(401, "Connexion requise");
  if (isBanned(req.user)) throw fail(403, "Compte banni");
  next();
}
function csrf(req, res, next) {
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.headers.origin !== origin
  )
    throw fail(403, "Origine refusée");
  next();
}
function admin(roles = ["TOURNAMENT_ADMIN", "SUPER_ADMIN"]) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role))
      throw fail(403, "Accès administrateur requis");
    next();
  };
}
function internal(req, res, next) {
  if (!equal(req.headers["x-api-key"], env.API_KEY))
    throw fail(401, "Unauthorized");
  next();
}
async function discord(url, token, options = {}) {
  const result = await fetch("https://discord.com/api/v10" + url, {
    ...options,
    headers: { Authorization: "Bearer " + token, ...options.headers },
    signal: AbortSignal.timeout(8000),
  });
  if (!result.ok)
    throw fail(
      result.status === 401 || result.status === 404 ? 403 : 503,
      "Vérification Discord indisponible ou membre absent",
    );
  return result.json();
}
async function verifyMembership(user) {
  if (!env.DISCORD_GUILD_ID || !user.guild_token)
    throw fail(503, "Discord doit être configuré");
  // Recheck membership for every registration and every new play token.
  await discord(
    `/users/@me/guilds/${env.DISCORD_GUILD_ID}/member`,
    decrypt(user.guild_token, env.SESSION_SECRET),
  );
}
async function game(pathname, body) {
  const result = await fetch(
    (env.GAME_INTERNAL_URL ?? "http://openfront:80") + pathname,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-bot-key": env.ADMIN_BOT_API_KEY,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!result.ok)
    throw fail(502, `Le serveur de jeu a refusé l’action (${result.status})`);
  return result.json();
}
app.get("/health", async (req, res) => {
  await db.query("SELECT 1");
  await redis.ping();
  res.json({
    status: "ok",
    release: env.GIT_COMMIT,
    discord: oauthReady() ? "configured" : "pending",
    bot: env.DISCORD_BOT_TOKEN ? "configured" : "pending",
  });
});
app.get("/.well-known/jwks.json", (req, res) => res.json({ keys: [jwk] }));
app.get("/config", (req, res) =>
  res.json({
    name: "AzertixYT OpenFront",
    release: env.GIT_COMMIT,
    discordReady: oauthReady(),
    ownerReady: /^[a-f0-9]{64}$/.test(env.OWNER_ACCESS_HASH ?? ""),
    codeAccess: true,
    guildId: env.DISCORD_GUILD_ID ?? null,
  }),
);
app.get(["/auth/login/discord", "/auth/discord"], async (req, res) => {
  if (!oauthReady())
    throw fail(
      503,
      "La connexion Discord attend la configuration de l’application et du serveur Discord.",
    );
  const state = crypto.randomBytes(32).toString("base64url");
  const binding = crypto.randomBytes(32).toString("base64url");
  await redis.set(
    "oauth:" + state,
    JSON.stringify({
      binding: hash(binding),
      redirect: safeRedirect(req.query.redirect_uri, origin),
    }),
    { EX: 600 },
  );
  res.cookie("azertix_oauth", binding, {
    httpOnly: true,
    secure: origin.startsWith("https:"),
    sameSite: "lax",
    path: "/",
    maxAge: 600000,
  });
  const url = new URL("https://discord.com/oauth2/authorize");
  url.search = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    redirect_uri: issuer + "/auth/discord/callback",
    response_type: "code",
    scope: "identify guilds.members.read",
    state,
  }).toString();
  res.redirect(url.href);
});
app.get("/auth/discord/callback", async (req, res) => {
  const state = parse(z.string().regex(/^[A-Za-z0-9_-]{43}$/), req.query.state);
  const saved = await redis.getDel("oauth:" + state);
  if (!saved) throw fail(400, "Connexion expirée");
  const data = JSON.parse(saved);
  if (!equal(hash(cookie(req, "azertix_oauth")), data.binding))
    throw fail(400, "État OAuth invalide");
  res.clearCookie("azertix_oauth", { path: "/" });
  const code = parse(z.string().min(1).max(2048), req.query.code);
  const response = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(8000),
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: issuer + "/auth/discord/callback",
    }),
  });
  if (!response.ok) throw fail(401, "Connexion Discord refusée");
  const tokens = await response.json();
  const profile = await discord("/users/@me", tokens.access_token);
  await discord(
    `/users/@me/guilds/${env.DISCORD_GUILD_ID}/member`,
    tokens.access_token,
  );
  await transaction(async (client) => {
    const result = await client.query(
      `INSERT INTO users(id,public_id,discord_id,username,avatar,discord_data,role,guild_checked_at,guild_token)
   VALUES($1,$2,$3,$4,$5,$6,$7,now(),$8) ON CONFLICT(discord_id) DO UPDATE SET username=EXCLUDED.username,avatar=EXCLUDED.avatar,
   discord_data=EXCLUDED.discord_data,guild_checked_at=now(),guild_token=EXCLUDED.guild_token RETURNING *`,
      [
        crypto.randomUUID(),
        crypto.randomUUID(),
        profile.id,
        profile.global_name ?? profile.username,
        profile.avatar,
        profile,
        bootstrapIds.includes(profile.id) ? "SUPER_ADMIN" : "PLAYER",
        encrypt(tokens.access_token, env.SESSION_SECRET),
      ],
    );
    const user = result.rows[0];
    if (isBanned(user)) throw fail(403, "Compte banni");
    if (bootstrapIds.includes(profile.id) && user.role !== "SUPER_ADMIN") {
      await client.query("UPDATE users SET role='SUPER_ADMIN' WHERE id=$1", [
        user.id,
      ]);
      user.role = "SUPER_ADMIN";
    }
    const token = crypto.randomBytes(48).toString("base64url");
    await client.query(
      "INSERT INTO sessions VALUES($1,$2,now()+interval '7 days')",
      [hash(token), user.id],
    );
    await audit(client, user, "login", user.public_id);
    sessionCookie(res, token);
    return user;
  });
  res.redirect(data.redirect);
});
app.post("/auth/refresh", csrf, async (req, res) => {
  const user = await sessionUser(req);
  if (!user) {
    sessionCookie(res, "", true);
    return res.status(401).json({ error: "Connexion requise" });
  }
  if (isBanned(user)) throw fail(403, "Compte banni");
  if (user.auth_provider === "discord") await verifyMembership(user);
  const jwt = await mint(user);
  res.json({ jwt, token: jwt, expiresIn: 300 });
});
app.post(
  "/auth/guest",
  (req, res, next) => {
    throw fail(403, "Connexion Discord requise");
  },
  csrf,
  rateLimit({ windowMs: 60000, limit: 15 }),
  async (req, res) => {
    let id = cookie(req, "azertix_guest");
    const parts = id.split(".");
    const signature = (value) =>
      crypto
        .createHmac("sha256", env.SESSION_SECRET)
        .update(value)
        .digest("base64url");
    if (
      !uuid.safeParse(parts[0]).success ||
      !equal(parts[1], signature(parts[0]))
    ) {
      const fresh = crypto.randomUUID();
      id = fresh + "." + signature(fresh);
      res.cookie("azertix_guest", id, {
        httpOnly: true,
        secure: origin.startsWith("https:"),
        sameSite: "lax",
        path: "/",
        maxAge: 7 * 86400000,
      });
    }
    const jwt = await mint({ id: id.split(".")[0], role: "PLAYER" }, true);
    res.json({ jwt, token: jwt, expiresIn: 300 });
  },
);
app.post("/auth/logout", csrf, async (req, res) => {
  await db.query("DELETE FROM sessions WHERE token_hash=$1", [
    hash(cookie(req, "azertix_session")),
  ]);
  sessionCookie(res, "", true);
  res.sendStatus(204);
});
async function historyFor(userId) {
  return (
    await db.query(
      `SELECT r.game_id,r.points,r.winner,coalesce(m.created_at,s.created_at) created_at,coalesce(t.name,s.name) name,m.round
    FROM results r LEFT JOIN tournaments t ON t.id=r.tournament_id
    LEFT JOIN matches m ON m.game_id=r.game_id LEFT JOIN rooms s ON s.game_id=r.game_id
    WHERE r.user_id=$1 ORDER BY coalesce(m.created_at,s.created_at) DESC LIMIT 100`,
      [userId],
    )
  ).rows;
}
app.get("/me/history", auth, async (req, res) =>
  res.json(await historyFor(req.user.id)),
);
app.get("/me", auth, async (req, res) => {
  const { id, public_id, discord_id, username, avatar, role, created_at } =
    req.user;
  const stats = await db.query(
    "SELECT count(*)::int games,coalesce(sum(points),0)::int points,count(*) FILTER(WHERE winner)::int wins FROM results WHERE user_id=$1",
    [id],
  );
  res.json({
    publicId: public_id,
    discordId: discord_id,
    provider: req.user.auth_provider,
    username,
    avatar,
    role,
    createdAt: created_at,
    ...stats.rows[0],
  });
});
app.get("/users/@me", async (req, res) => {
  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  let payload;
  try {
    ({ payload } = await jwtVerify(token, publicKey, {
      issuer,
      audience: domain,
      algorithms: ["EdDSA"],
    }));
  } catch {
    throw fail(401, "Token invalide");
  }
  const raw = Buffer.from(payload.sub ?? "", "base64url").toString("hex");
  if (raw.length !== 32) throw fail(401, "Token invalide");
  const id = [
    raw.slice(0, 8),
    raw.slice(8, 12),
    raw.slice(12, 16),
    raw.slice(16, 20),
    raw.slice(20),
  ].join("-");
  const result = await db.query("SELECT * FROM users WHERE id=$1", [id]);
  const user = result.rows[0];
  if (payload.provider !== "guest" && !user) throw fail(401, "Compte absent");
  if (user && isBanned(user)) throw fail(403, "Compte banni");
  res.json({
    user:
      user?.auth_provider === "discord" ? { discord: user.discord_data } : {},
    player: {
      publicId: user?.public_id ?? id,
      username: user?.username ?? null,
      adfree: true,
      unlimitedRanked: false,
      canCreatePublicLobbies: false,
      trustTier:
        user && user.auth_provider !== "guest" ? "trusted" : "untrusted",
      subscription: null,
      flares: [],
      friends: [],
      achievements: { singleplayerMap: [], player: [] },
    },
  });
});
app.get("/tournaments", async (req, res) =>
  res.json(
    (
      await db.query(`SELECT t.*,count(p.user_id)::int registered FROM tournaments t
 LEFT JOIN participants p ON p.tournament_id=t.id GROUP BY t.id ORDER BY t.starts_at DESC LIMIT 100`)
    ).rows,
  ),
);
app.get("/leaderboard", async (req, res) =>
  res.json(
    (
      await db.query(`SELECT u.public_id,u.username,coalesce(sum(r.points),0)::int points,
 count(r.game_id) FILTER(WHERE r.winner)::int wins,count(r.game_id)::int games FROM users u JOIN results r ON r.user_id=u.id
 GROUP BY u.id ORDER BY points DESC,wins DESC,u.username LIMIT 200`)
    ).rows,
  ),
);
app.get("/tournaments/:id", async (req, res) => {
  const id = parse(uuid, req.params.id);
  const tournament = (
    await db.query("SELECT * FROM tournaments WHERE id=$1", [id])
  ).rows[0];
  if (!tournament) throw fail(404, "Tournoi absent");
  const matches = (
    await db.query(
      "SELECT id,round,game_id,status FROM matches WHERE tournament_id=$1 ORDER BY round",
      [id],
    )
  ).rows;
  const standings = (
    await db.query(
      `SELECT u.public_id,u.username,coalesce(sum(r.points),0)::int points,count(r.game_id) FILTER(WHERE r.winner)::int wins
  FROM participants p JOIN users u ON u.id=p.user_id LEFT JOIN results r ON r.user_id=p.user_id AND r.tournament_id=p.tournament_id
  WHERE p.tournament_id=$1 GROUP BY u.id ORDER BY points DESC,wins DESC,u.username`,
      [id],
    )
  ).rows;
  res.json({ ...tournament, matches, standings });
});
app.post("/tournaments/:id/register", csrf, auth, async (req, res) => {
  const id = parse(uuid, req.params.id);
  await verifyMembership(req.user);
  await transaction(async (client) => {
    const tournament = (
      await client.query("SELECT * FROM tournaments WHERE id=$1 FOR UPDATE", [
        id,
      ])
    ).rows[0];
    if (!tournament) throw fail(404, "Tournoi absent");
    if (tournament.status !== "open") throw fail(409, "Inscriptions fermées");
    if (
      (
        await client.query(
          "SELECT 1 FROM participants WHERE tournament_id=$1 AND user_id=$2",
          [id, req.user.id],
        )
      ).rowCount
    )
      return;
    const { count } = (
      await client.query(
        "SELECT count(*)::int count FROM participants WHERE tournament_id=$1",
        [id],
      )
    ).rows[0];
    if (count >= tournament.capacity) throw fail(409, "Tournoi complet");
    await client.query("INSERT INTO participants VALUES($1,$2,now())", [
      id,
      req.user.id,
    ]);
    await audit(client, req.user, "register", id);
  });
  res.sendStatus(204);
});
app.post("/tournaments/:id/unregister", csrf, auth, async (req, res) => {
  const id = parse(uuid, req.params.id);
  await transaction(async (client) => {
    const t = (
      await client.query(
        "SELECT status FROM tournaments WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!t || t.status !== "open") throw fail(409, "Inscriptions fermées");
    await client.query(
      "DELETE FROM participants WHERE tournament_id=$1 AND user_id=$2",
      [id, req.user.id],
    );
    await audit(client, req.user, "unregister", id);
  });
  res.sendStatus(204);
});
registerRooms({
  app,
  db,
  env,
  origin,
  csrf,
  auth,
  admin,
  parse,
  fail,
  transaction,
  audit,
  game,
  mint,
  sessionUser,
  sessionCookie,
  verifyMembership,
});
app.use("/admin", csrf, auth);
app.get(
  "/admin/live",
  admin(["MODERATOR", "TOURNAMENT_ADMIN", "SUPER_ADMIN"]),
  async (req, res) => {
    const started = Date.now();
    const [health, connections] = await Promise.all([
      game("/api/health"),
      game("/w0/api/adminbot/live"),
    ]);
    const stats = (
      await db.query(`SELECT (SELECT count(*) FROM sessions WHERE expires_at>now())::int sessions,
  (SELECT count(*) FROM matches WHERE status IN ('lobby','running','paused'))::int active_matches,
  (SELECT count(*) FROM users)::int users`)
    ).rows[0];
    res.json({
      ...stats,
      game: health,
      connections,
      host: {
        loadAverage: os.loadavg(),
        cpuCount: os.availableParallelism(),
        memoryTotalBytes: os.totalmem(),
        memoryFreeBytes: os.freemem(),
      },
      latencyMs: Date.now() - started,
      memoryBytes: process.memoryUsage().rss,
      uptimeSeconds: Math.floor(process.uptime()),
      release: env.GIT_COMMIT,
      discord: oauthReady(),
      bot: Boolean(env.DISCORD_BOT_TOKEN),
    });
  },
);
app.post("/admin/tournaments", admin(), async (req, res) => {
  const input = parse(TournamentInputSchema, req.body);
  const id = crypto.randomUUID();
  await transaction(async (client) => {
    await client.query(
      "INSERT INTO tournaments(id,name,starts_at,capacity,rounds,rules,game_config) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        id,
        input.name,
        input.startsAt,
        input.capacity,
        input.rounds,
        input.rules,
        roomGameConfig(
          RoomInputSchema.parse(
            nativeToRoomInput(
              input.gameConfig,
              "Configuration",
              input.capacity,
            ),
          ),
        ),
      ],
    );
    await audit(client, req.user, "create_tournament", id);
  });
  res.status(201).json({ id });
});
app.post("/admin/tournaments/:id/status", admin(), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const { status } = parse(
    z.object({ status: z.enum(["open", "closed", "running", "finished"]) }),
    req.body,
  );
  const transitions = {
    draft: ["open"],
    open: ["closed"],
    closed: ["open", "running"],
    running: ["finished"],
    finished: [],
  };
  await transaction(async (client) => {
    const t = (
      await client.query("SELECT * FROM tournaments WHERE id=$1 FOR UPDATE", [
        id,
      ])
    ).rows[0];
    if (!t) throw fail(404, "Tournoi absent");
    if (!transitions[t.status].includes(status))
      throw fail(409, "Transition de tournoi refusée");
    if (
      status === "finished" &&
      (
        await client.query(
          "SELECT 1 FROM matches WHERE tournament_id=$1 AND status NOT IN ('finished','cancelled')",
          [id],
        )
      ).rowCount
    )
      throw fail(409, "Une partie est encore active");
    await client.query("UPDATE tournaments SET status=$1 WHERE id=$2", [
      status,
      id,
    ]);
    await audit(client, req.user, "tournament_" + status, id);
    await client.query("INSERT INTO announcements(content) VALUES($1)", [
      `🏆 ${t.name} — ${status}\n${origin}/tournaments#${id}`,
    ]);
  });
  res.sendStatus(204);
});
app.post("/admin/tournaments/:id/matches", admin(), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const match = await transaction(async (client) => {
    const t = (
      await client.query("SELECT * FROM tournaments WHERE id=$1 FOR UPDATE", [
        id,
      ])
    ).rows[0];
    if (!t || t.status !== "running")
      throw fail(409, "Démarrer le tournoi avant de créer une manche");
    const previous = (
      await client.query(
        "SELECT * FROM matches WHERE tournament_id=$1 ORDER BY round DESC LIMIT 1",
        [id],
      )
    ).rows[0];
    if (previous && !["finished", "cancelled"].includes(previous.status))
      throw fail(409, "La manche précédente est encore active");
    const round = (previous?.round ?? 0) + 1;
    if (round > t.rounds) throw fail(409, "Toutes les manches ont été créées");
    const participants = (
      await client.query(
        `SELECT u.public_id FROM participants p JOIN users u ON u.id=p.user_id
   WHERE p.tournament_id=$1 AND NOT (u.banned AND (u.ban_until IS NULL OR u.ban_until>now()))`,
        [id],
      )
    ).rows;
    if (participants.length < 2) throw fail(409, "Deux participants minimum");
    const config = {
      ...t.game_config,
      gameType: "Private",
      maxPlayers: t.capacity,
      allowedPublicIds: participants.map((p) => p.public_id),
      listed: false,
      featured: false,
    };
    const lobby = await game("/api/adminbot/create_game", config);
    const gameId = lobby.gameID ?? lobby.id;
    if (!gameId || !Number.isInteger(lobby.workerIndex))
      throw fail(502, "Réponse du jeu invalide");
    const matchId = crypto.randomUUID();
    await client.query(
      "INSERT INTO matches(id,tournament_id,round,game_id,worker,config) VALUES($1,$2,$3,$4,$5,$6)",
      [matchId, id, round, gameId, lobby.workerIndex, config],
    );
    await audit(client, req.user, "create_match", gameId);
    await client.query("INSERT INTO announcements(content) VALUES($1)", [
      `🎮 ${t.name} — manche ${round}\n${origin}/game/${gameId}`,
    ]);
    return { id: matchId, gameId, round };
  });
  res.status(201).json(match);
});
app.get(
  "/admin/matches",
  admin(["MODERATOR", "TOURNAMENT_ADMIN", "SUPER_ADMIN"]),
  async (req, res) =>
    res.json(
      (
        await db.query(
          "SELECT m.*,t.name FROM matches m JOIN tournaments t ON t.id=m.tournament_id ORDER BY m.created_at DESC LIMIT 100",
        )
      ).rows,
    ),
);
// Recreate a cancelled round with a new engine lobby, without erasing scored games.
app.post("/admin/matches/:id/restart", admin(), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const match = await transaction(async (client) => {
    const m = (
      await client.query("SELECT * FROM matches WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!m || m.status !== "cancelled")
      throw fail(409, "Annuler la manche avant de la recréer");
    const t = (
      await client.query(
        "SELECT status FROM tournaments WHERE id=$1 FOR UPDATE",
        [m.tournament_id],
      )
    ).rows[0];
    if (t?.status !== "running")
      throw fail(409, "Le tournoi doit être en cours");
    if (
      (
        await client.query(
          "SELECT 1 FROM matches WHERE tournament_id=$1 AND round>$2",
          [m.tournament_id, m.round],
        )
      ).rowCount
    )
      throw fail(409, "Une manche suivante existe déjà");
    const lobby = await game("/api/adminbot/create_game", m.config);
    const gameId = lobby.gameID ?? lobby.id;
    if (!gameId || !Number.isInteger(lobby.workerIndex))
      throw fail(502, "Réponse du jeu invalide");
    await client.query(
      "UPDATE matches SET game_id=$1,worker=$2,status='lobby' WHERE id=$3",
      [gameId, lobby.workerIndex, id],
    );
    await audit(client, req.user, "restart_match", gameId);
    await client.query("INSERT INTO announcements(content) VALUES($1)", [
      `🎮 Manche ${m.round} recréée\n${origin}/game/${gameId}`,
    ]);
    return { id, gameId, round: m.round };
  });
  res.status(201).json(match);
});
app.post("/admin/matches/:id/action", admin(), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const input = parse(
    z.object({
      action: z.enum(["start", "pause", "resume", "cancel", "kick"]),
      clientId: z.string().max(64).optional(),
    }),
    req.body,
  );
  await transaction(async (client) => {
    const match = (
      await client.query("SELECT * FROM matches WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!match) throw fail(404, "Partie absente");
    if (["finished", "cancelled"].includes(match.status))
      throw fail(409, "Partie terminée");
    if (input.action === "start" && match.status !== "lobby")
      throw fail(409, "Partie déjà démarrée");
    if (input.action === "pause" && match.status !== "running")
      throw fail(409, "Partie non démarrée");
    if (input.action === "resume" && match.status !== "paused")
      throw fail(409, "Partie non suspendue");
    let intent;
    if (input.action === "start") intent = { type: "toggle_game_start_timer" };
    if (input.action === "pause" || input.action === "resume")
      intent = { type: "toggle_pause", paused: input.action === "pause" };
    if (input.action === "kick") {
      if (!input.clientId) throw fail(400, "Joueur requis");
      intent = { type: "kick_player", targetClientID: input.clientId };
    }
    if (input.action === "cancel")
      await game(
        `/w${match.worker}/api/adminbot/game/${match.game_id}/cancel`,
        {},
      );
    else
      await game(
        `/w${match.worker}/api/adminbot/game/${match.game_id}/intent`,
        intent,
      );
    if (input.action !== "kick")
      await client.query("UPDATE matches SET status=$1 WHERE id=$2", [
        {
          start: "running",
          pause: "paused",
          resume: "running",
          cancel: "cancelled",
        }[input.action],
        id,
      ]);
    await audit(client, req.user, "match_" + input.action, match.game_id);
  });
  res.sendStatus(204);
});
app.get(
  "/admin/matches/:id/roster",
  admin(["MODERATOR", "TOURNAMENT_ADMIN", "SUPER_ADMIN"]),
  async (req, res) => {
    const id = parse(uuid, req.params.id);
    const m = (await db.query("SELECT * FROM matches WHERE id=$1", [id]))
      .rows[0];
    if (!m) throw fail(404, "Partie absente");
    res.json(await game(`/w${m.worker}/api/adminbot/game/${m.game_id}/roster`));
  },
);
app.get(
  "/admin/users",
  admin(["MODERATOR", "TOURNAMENT_ADMIN", "SUPER_ADMIN"]),
  async (req, res) => {
    const query = parse(z.string().max(120), req.query.q ?? "");
    res.json(
      (
        await db.query(
          "SELECT public_id,discord_id,username,role,auth_provider,banned,ban_until,ban_reason,created_at FROM users WHERE username ILIKE $1 OR discord_id=$2 ORDER BY created_at DESC LIMIT 100",
          ["%" + query + "%", query],
        )
      ).rows,
    );
  },
);
app.get(
  "/admin/users/:id/history",
  admin(["MODERATOR", "TOURNAMENT_ADMIN", "SUPER_ADMIN"]),
  async (req, res) => {
    const id = parse(uuid, req.params.id);
    const user = (
      await db.query("SELECT id,username FROM users WHERE public_id=$1", [id])
    ).rows[0];
    if (!user) throw fail(404, "Joueur absent");
    res.json({ username: user.username, history: await historyFor(user.id) });
  },
);
app.post(
  "/admin/users/:id/ban",
  admin(["MODERATOR", "SUPER_ADMIN"]),
  async (req, res) => {
    const id = parse(uuid, req.params.id);
    const input = parse(
      z.object({
        banned: z.boolean(),
        until: z.iso.datetime().nullable().default(null),
        reason: z.string().max(500).default(""),
      }),
      req.body,
    );
    if (input.until && new Date(input.until) <= new Date())
      throw fail(400, "Expiration passée");
    await transaction(async (client) => {
      const target = (
        await client.query(
          "SELECT * FROM users WHERE public_id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!target) throw fail(404, "Joueur absent");
      if (
        target.id === req.user.id ||
        target.role === "SUPER_ADMIN" ||
        (target.role !== "PLAYER" && req.user.role !== "SUPER_ADMIN")
      )
        throw fail(403, "Modération de ce compte refusée");
      await client.query(
        "UPDATE users SET banned=$1,ban_until=$2,ban_reason=$3 WHERE id=$4",
        [input.banned, input.until, input.reason, target.id],
      );
      if (input.banned)
        await client.query("DELETE FROM sessions WHERE user_id=$1", [
          target.id,
        ]);
      await audit(client, req.user, input.banned ? "ban" : "unban", id);
    });
    res.sendStatus(204);
  },
);
app.post("/admin/users/:id/role", admin(["SUPER_ADMIN"]), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const { role } = parse(
    z.object({
      role: z.enum(["PLAYER", "MODERATOR", "TOURNAMENT_ADMIN", "SUPER_ADMIN"]),
    }),
    req.body,
  );
  await transaction(async (client) => {
    const target = (
      await client.query("SELECT * FROM users WHERE public_id=$1 FOR UPDATE", [
        id,
      ])
    ).rows[0];
    if (!target) throw fail(404, "Joueur absent");
    if (
      target.id === req.user.id ||
      target.auth_provider === "owner" ||
      bootstrapIds.includes(target.discord_id)
    )
      throw fail(409, "Rôle du compte de secours protégé");
    if (target.auth_provider === "guest" && role !== "PLAYER")
      throw fail(
        403,
        "Un compte invité ne peut pas recevoir de droits administrateur",
      );
    await client.query("UPDATE users SET role=$1 WHERE id=$2", [
      role,
      target.id,
    ]);
    await audit(client, req.user, "role_" + role, id);
  });
  res.sendStatus(204);
});
app.get("/admin/logs", admin(["SUPER_ADMIN"]), async (req, res) =>
  res.json(
    (
      await db.query(
        "SELECT a.id,a.action,a.target,a.created_at,u.username FROM audit_logs a LEFT JOIN users u ON u.id=a.actor ORDER BY a.id DESC LIMIT 200",
      )
    ).rows,
  ),
);
// OpenFront bridge. Authenticated game servers are the only result writers.
app.post("/game/:id", internal, async (req, res) => {
  const gameId = parse(
    z.string().regex(/^[a-z][A-Za-z0-9_-]{9}$/),
    req.params.id,
  );
  const record = req.body;
  if (
    record?.info?.gameID !== gameId ||
    !Array.isArray(record?.info?.players) ||
    record.info.players.length > 200
  )
    throw fail(400, "Résultat invalide");
  await transaction(async (client) => {
    const match = (
      await client.query("SELECT * FROM matches WHERE game_id=$1 FOR UPDATE", [
        gameId,
      ])
    ).rows[0];
    const insert = await client.query(
      "INSERT INTO archives(game_id,record) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING game_id",
      [gameId, scrubRecord(record)],
    );
    if (!insert.rowCount) return;
    if (!match) {
      const room = (
        await client.query("SELECT * FROM rooms WHERE game_id=$1 FOR UPDATE", [
          gameId,
        ])
      ).rows[0];
      if (!room || ["cancelled", "finished"].includes(room.status)) return;
      const winners = winningClients(record.info.winner);
      if (winners.size)
        for (const player of record.info.players) {
          if (!uuid.safeParse(player.persistentID).success) continue;
          const winner = winners.has(player.clientID);
          await client.query(
            `INSERT INTO results(game_id,tournament_id,user_id,winner,points)
          SELECT $1,NULL,p.user_id,$3,$4 FROM room_players p WHERE p.room_id=$2 AND p.user_id=$5 ON CONFLICT DO NOTHING`,
            [gameId, room.id, winner, winner ? 10 : 1, player.persistentID],
          );
        }
      await client.query("UPDATE rooms SET status=$1 WHERE id=$2", [
        winners.size ? "finished" : "cancelled",
        room.id,
      ]);
      return;
    }
    if (match.status === "cancelled") return;
    const winners = winningClients(record.info.winner);
    // Aborted games never award participation points or wins.
    if (!winners.size) {
      await client.query("UPDATE matches SET status='cancelled' WHERE id=$1", [
        match.id,
      ]);
      return;
    }
    for (const player of record.info.players) {
      if (!uuid.safeParse(player.persistentID).success) continue;
      const winner = winners.has(player.clientID);
      await client.query(
        `INSERT INTO results(game_id,tournament_id,user_id,winner,points)
    SELECT $1,$2,p.user_id,$4,$5 FROM participants p WHERE p.tournament_id=$2 AND p.user_id=$3 ON CONFLICT DO NOTHING`,
        [
          gameId,
          match.tournament_id,
          player.persistentID,
          winner,
          winner ? 10 : 1,
        ],
      );
    }
    await client.query("UPDATE matches SET status='finished' WHERE id=$1", [
      match.id,
    ]);
    await audit(client, null, "match_result", gameId);
    await client.query("INSERT INTO announcements(content) VALUES($1)", [
      `🏆 Résultat de la manche ${match.round}\n${origin}/tournaments#${match.tournament_id}`,
    ]);
  });
  res.sendStatus(204);
});
app.get("/game/:id", async (req, res) => {
  const record = (
    await db.query("SELECT record FROM archives WHERE game_id=$1", [
      req.params.id,
    ])
  ).rows[0];
  if (!record) throw fail(404, "Partie absente");
  res.json(record.record);
});
app.post("/cluster/checkin", internal, async (req, res) => {
  const body = parse(
    z.object({
      host: z.literal(domain),
      letter: z.literal("a"),
      version: z.string().regex(/^[a-f0-9]{40}$/),
      numWorkers: z.literal(1),
      liveGames: z.number().int().nonnegative(),
    }),
    req.body,
  );
  await redis.set("game:checkin", JSON.stringify(body), { EX: 45 });
  res.json({ state: "open" });
});
app.get(["/servers", "/cluster.json"], async (req, res) => {
  const raw = await redis.get("game:checkin");
  if (!raw) return res.json({ servers: {} });
  const state = JSON.parse(raw);
  res.json({
    latest: state.version,
    servers: {
      a: { host: domain, numWorkers: 1, version: state.version, state: "open" },
    },
  });
});
app.post("/custom_tribes", internal, (req, res) => res.json({ tribes: [] }));
app.get("/reserved_clan_tags", (req, res) => res.json([]));
app.get("/cosmetics.json", async (req, res) =>
  res.sendFile(path.join(root, "cosmetics.json")),
);
app.post("/join_verify", internal, (req, res) => {
  const input = parse(
    z.object({
      username: z.string().max(100),
      clanTag: z.string().nullable().optional(),
    }),
    req.body,
  );
  res.json({
    status: "approved",
    username: input.username,
    clanTag: input.clanTag ?? null,
  });
});
app.get("/news.json", (req, res) => res.json([]));
for (const route of [
  "/admin-page",
  "/tournaments-page",
  "/profile-page",
  "/login-page",
]) {
  app.get(route, (req, res) =>
    res.sendFile(path.join(root, "public/index.html")),
  );
}
app.use("/ui", express.static(path.join(root, "public")));
app.use((req, res) =>
  res.status(404).json({ error: "Route indisponible sur cette plateforme" }),
);
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error(
    JSON.stringify({
      event: "request_failed",
      path: req.path,
      status: err.status ?? 500,
    }),
  );
  res.status(err.status ?? 500).json({
    error: err.status ? err.message : "Service temporairement indisponible",
  });
});
const cleanup = setInterval(
  () => db.query("DELETE FROM sessions WHERE expires_at<now()").catch(() => {}),
  3600000,
);
cleanup.unref();
const server = app.listen(3400, "0.0.0.0", () => {
  console.log("Azertix platform listening on 3400");
  startDiscordBot({ db, origin, env });
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () =>
    server.close(async () => {
      await db.end();
      await redis.quit();
      process.exit(0);
    }),
  );
