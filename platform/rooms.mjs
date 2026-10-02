import { rateLimit } from "express-rate-limit";
import crypto from "node:crypto";
import { z } from "zod";
import { cookie, equal, hash, isBanned } from "./security.mjs";

export function registerRooms({
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
}) {
  const roomID = z.uuid();
  const signing = (id) =>
    crypto
      .createHmac("sha256", env.SESSION_SECRET)
      .update(id)
      .digest("base64url");
  const loginSession = async (client, user, res, hours = 168) => {
    const token = crypto.randomBytes(48).toString("base64url");
    await client.query(
      "INSERT INTO sessions VALUES($1,$2,now()+$3*interval '1 hour')",
      [hash(token), user.id, hours],
    );
    sessionCookie(res, token);
  };
  app.post(
    "/auth/owner",
    csrf,
    rateLimit({ windowMs: 15 * 60000, limit: 8 }),
    async (req, res) => {
      const { key } = parse(
        z.object({ key: z.string().min(16).max(256) }),
        req.body,
      );
      if (!/^[a-f0-9]{64}$/.test(env.OWNER_ACCESS_HASH ?? ""))
        throw fail(
          503,
          "La connexion propriétaire doit être activée sur le serveur",
        );
      if (!equal(hash(key), env.OWNER_ACCESS_HASH))
        throw fail(401, "Clé propriétaire incorrecte");
      await transaction(async (client) => {
        const user = (
          await client.query(
            `INSERT INTO users(id,public_id,discord_id,username,role,auth_provider)
        VALUES($1,$2,'owner:primary','Baptiste','SUPER_ADMIN','owner')
        ON CONFLICT(discord_id) DO UPDATE SET role='SUPER_ADMIN',auth_provider='owner' RETURNING *`,
            [crypto.randomUUID(), crypto.randomUUID()],
          )
        ).rows[0];
        await loginSession(client, user, res, 12);
        await audit(client, user, "owner_login", user.public_id);
      });
      res.sendStatus(204);
    },
  );

  async function liveRoom(room, client = db) {
    if (!room || !["lobby", "running", "paused"].includes(room.status))
      throw fail(404, "Code inconnu ou salon fermé");
    const state = await game(
      `/w${room.worker}/api/game/${room.game_id}/exists`,
    );
    if (!state.exists) {
      await client.query("UPDATE rooms SET status='cancelled' WHERE id=$1", [
        room.id,
      ]);
      throw fail(
        410,
        "Ce salon a expiré. Demande un nouveau code à l’organisateur",
      );
    }
  }

  app.post(
    "/auth/code",
    csrf,
    rateLimit({ windowMs: 60000, limit: 25 }),
    async (req, res) => {
      const input = parse(
        z.object({
          code: z
            .string()
            .trim()
            .toUpperCase()
            .regex(/^[A-Z2-9]{8}$/),
          username: z.string().trim().min(2).max(24),
        }),
        req.body,
      );
      const room = (
        await db.query("SELECT * FROM rooms WHERE code=$1", [input.code])
      ).rows[0];
      await liveRoom(room);
      const current = await sessionUser(req);
      const [guestId, sig] = cookie(req, "azertix_guest").split(".");
      const signedGuest =
        roomID.safeParse(guestId).success && equal(sig, signing(guestId));
      const identity =
        current?.id ?? (signedGuest ? guestId : crypto.randomUUID());
      await transaction(async (client) => {
        const locked = (
          await client.query("SELECT * FROM rooms WHERE id=$1 FOR UPDATE", [
            room.id,
          ])
        ).rows[0];
        if (!["lobby", "running", "paused"].includes(locked.status))
          throw fail(409, "Ce salon est fermé");
        let user =
          current ??
          (await client.query("SELECT * FROM users WHERE id=$1", [identity]))
            .rows[0];
        if (user && isBanned(user)) throw fail(403, "Compte banni");
        const already = (
          await client.query(
            "SELECT 1 FROM room_players WHERE room_id=$1 AND user_id=$2",
            [room.id, identity],
          )
        ).rowCount;
        if (
          !already &&
          locked.status !== "lobby" &&
          !["SUPER_ADMIN", "TOURNAMENT_ADMIN"].includes(user?.role)
        )
          throw fail(409, "La partie a déjà démarré");
        if (!already) {
          const count = (
            await client.query(
              "SELECT count(*)::int n FROM room_players WHERE room_id=$1",
              [room.id],
            )
          ).rows[0].n;
          if (count >= room.capacity) throw fail(409, "Ce salon est complet");
        }
        if (!user)
          user = (
            await client.query(
              `INSERT INTO users(id,public_id,discord_id,username,auth_provider)
        VALUES($1,$2,$3,$4,'guest') RETURNING *`,
              [
                identity,
                crypto.randomUUID(),
                "guest:" + identity,
                input.username,
              ],
            )
          ).rows[0];
        else if (user.auth_provider === "guest")
          await client.query("UPDATE users SET username=$1 WHERE id=$2", [
            input.username,
            identity,
          ]);
        await client.query(
          "INSERT INTO room_players(room_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [room.id, identity],
        );
        await loginSession(client, user, res);
        if (user.auth_provider === "guest")
          res.cookie("azertix_guest", identity + "." + signing(identity), {
            httpOnly: true,
            secure: origin.startsWith("https:"),
            sameSite: "lax",
            path: "/",
            maxAge: 7 * 86400000,
          });
      });
      res.json({ gameId: room.game_id, name: room.name });
    },
  );

  app.post(
    "/auth/play-token",
    csrf,
    auth,
    rateLimit({ windowMs: 60000, limit: 30 }),
    async (req, res) => {
      const { gameId } = parse(
        z.object({ gameId: z.string().regex(/^[a-z][A-Za-z0-9_-]{9}$/) }),
        req.body,
      );
      if (
        ["SUPER_ADMIN", "TOURNAMENT_ADMIN", "MODERATOR"].includes(req.user.role)
      ) {
        if (req.user.auth_provider === "discord")
          await verifyMembership(req.user);
        const jwt = await mint(req.user);
        return res.json({ jwt });
      }
      const room = (
        await db.query(
          `SELECT r.* FROM rooms r JOIN room_players p ON p.room_id=r.id WHERE r.game_id=$1 AND p.user_id=$2`,
          [gameId, req.user.id],
        )
      ).rows[0];
      if (room) {
        await liveRoom(room);
        const jwt = await mint(req.user, false, "code:" + gameId);
        return res.json({ jwt });
      }
      // Existing Discord tournaments keep their participant allowlists.
      if (req.user.auth_provider === "discord") {
        const member = await db.query(
          `SELECT 1 FROM matches m JOIN participants p ON p.tournament_id=m.tournament_id WHERE m.game_id=$1 AND p.user_id=$2 AND m.status IN ('lobby','running','paused')`,
          [gameId, req.user.id],
        );
        if (member.rowCount) {
          await verifyMembership(req.user);
          const jwt = await mint(req.user);
          return res.json({ jwt });
        }
      }
      throw fail(403, "Entre le code du salon pour rejoindre cette partie");
    },
  );

  // Keep these guards on the routes themselves: they are registered before /admin middleware.
  app.get("/me/rooms", auth, async (req, res) =>
    res.json(
      (
        await db.query(
          `SELECT r.name,r.game_id,r.status,r.created_at FROM rooms r JOIN room_players p ON p.room_id=r.id WHERE p.user_id=$1 ORDER BY r.created_at DESC LIMIT 30`,
          [req.user.id],
        )
      ).rows,
    ),
  );
  app.get(
    "/admin/rooms",
    csrf,
    auth,
    admin(["MODERATOR", "TOURNAMENT_ADMIN", "SUPER_ADMIN"]),
    async (req, res) => {
      await db.query(
        "UPDATE rooms SET status='cancelled' WHERE release<>$1 AND status IN ('lobby','running','paused')",
        [env.GIT_COMMIT],
      );
      res.json(
        (
          await db.query(
            `SELECT r.*,count(p.user_id)::int registered FROM rooms r LEFT JOIN room_players p ON p.room_id=r.id GROUP BY r.id ORDER BY r.created_at DESC LIMIT 100`,
          )
        ).rows,
      );
    },
  );
  app.post(
    "/admin/rooms",
    csrf,
    auth,
    admin(),
    rateLimit({ windowMs: 60000, limit: 5 }),
    async (req, res) => {
      const input = parse(
        z.object({
          name: z.string().trim().min(2).max(80),
          capacity: z.number().int().min(2).max(200).default(20),
          map: z.enum(["World", "Europe", "France"]).default("World"),
          bots: z.number().int().min(0).max(400).default(100),
          nations: z
            .union([z.literal("disabled"), z.literal("default")])
            .default("default"),
        }),
        req.body,
      );
      const config = {
        gameMap: input.map,
        gameType: "Private",
        gameMode: "Free For All",
        maxPlayers: input.capacity,
        bots: input.bots,
        nations: input.nations,
        listed: false,
        featured: false,
      };
      const lobby = await game("/api/adminbot/create_game", config);
      const gameId = lobby.gameID ?? lobby.id;
      if (!gameId || !Number.isInteger(lobby.workerIndex))
        throw fail(502, "Réponse du jeu invalide");
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const code = Array.from(
        crypto.randomBytes(8),
        (n) => alphabet[n % alphabet.length],
      ).join("");
      const room = await transaction(async (client) => {
        const row = (
          await client.query(
            `INSERT INTO rooms(id,name,code,game_id,worker,capacity,config,created_by,release) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [
              crypto.randomUUID(),
              input.name,
              code,
              gameId,
              lobby.workerIndex,
              input.capacity,
              config,
              req.user.id,
              env.GIT_COMMIT,
            ],
          )
        ).rows[0];
        await audit(client, req.user, "create_room", row.id);
        return row;
      });
      res.status(201).json(room);
    },
  );
  app.get(
    "/admin/rooms/:id/players",
    csrf,
    auth,
    admin(["MODERATOR", "TOURNAMENT_ADMIN", "SUPER_ADMIN"]),
    async (req, res) => {
      const id = parse(roomID, req.params.id);
      const room = (await db.query("SELECT * FROM rooms WHERE id=$1", [id]))
        .rows[0];
      await liveRoom(room);
      res.json(
        await game(`/w${room.worker}/api/adminbot/game/${room.game_id}/roster`),
      );
    },
  );
  app.post("/admin/rooms/:id/action", csrf, auth, admin(), async (req, res) => {
    const id = parse(roomID, req.params.id);
    const input = parse(
      z.object({
        action: z.enum(["start", "pause", "resume", "cancel", "kick"]),
        clientId: z.string().optional(),
      }),
      req.body,
    );
    await transaction(async (client) => {
      const room = (
        await client.query("SELECT * FROM rooms WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      await liveRoom(room, client);
      const expected = { start: "lobby", pause: "running", resume: "paused" }[
        input.action
      ];
      if (expected && room.status !== expected)
        throw fail(409, "Cette action ne correspond pas à l’état de la partie");
      if (input.action === "kick" && !input.clientId)
        throw fail(400, "Joueur requis");
      const route = `/w${room.worker}/api/adminbot/game/${room.game_id}`;
      if (input.action === "cancel") await game(route + "/cancel", {});
      else
        await game(
          route + "/intent",
          input.action === "start"
            ? { type: "toggle_game_start_timer" }
            : input.action === "kick"
              ? { type: "kick_player", targetClientID: input.clientId }
              : { type: "toggle_pause", paused: input.action === "pause" },
        );
      const state = {
        start: "running",
        pause: "paused",
        resume: "running",
        cancel: "cancelled",
      }[input.action];
      if (state)
        await client.query("UPDATE rooms SET status=$1 WHERE id=$2", [
          state,
          id,
        ]);
      await audit(client, req.user, "room_" + input.action, id);
    });
    res.sendStatus(204);
  });
}
