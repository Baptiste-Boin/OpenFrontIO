import { randomBytes } from "node:crypto";
import { hash, isBanned } from "./security.mjs";
export function startDiscordBot({ db, origin, env }) {
  const token = env.DISCORD_BOT_TOKEN,
    guild = env.DISCORD_GUILD_ID,
    appId = env.DISCORD_CLIENT_ID;
  if (!token || !guild || !appId) return;
  let socket,
    heartbeat,
    retryTimer,
    sequence = null,
    ack = true,
    stopped = false;
  const rest = async (route, method = "GET", body) => {
    const response = await fetch("https://discord.com/api/v10" + route, {
      method,
      headers: {
        Authorization: "Bot " + token,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Discord HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  const string = (name, description, required = false) => ({
    type: 3,
    name,
    description,
    required,
  });
  const commands = [
    { name: "tournoi", description: "Voir le prochain tournoi" },
    { name: "classement", description: "Voir le classement de la communauté" },
    { name: "profil", description: "Voir ton profil OpenFront" },
    {
      name: "inscription",
      description: "Participer au tournoi ouvert",
      options: [string("tournoi", "Identifiant du tournoi (facultatif)")],
    },
    { name: "prochaine-partie", description: "Rejoindre la prochaine manche" },
    {
      name: "tournament",
      description: "Administration des tournois",
      default_member_permissions: "0",
      options: [
        {
          type: 1,
          name: "create",
          description: "Créer un tournoi",
          options: [
            string("nom", "Nom", true),
            string("date", "Date ISO UTC (2026-10-02T18:00:00Z)", true),
            {
              type: 4,
              name: "places",
              description: "Places",
              min_value: 2,
              max_value: 200,
            },
            {
              type: 4,
              name: "manches",
              description: "Manches",
              min_value: 1,
              max_value: 20,
            },
          ],
        },
        ...["open", "close", "start", "end"].map((name) => ({
          type: 1,
          name,
          description: "Modifier le tournoi",
          options: [string("id", "Identifiant du tournoi", true)],
        })),
      ],
    },
    {
      name: "match",
      description: "Administration des manches",
      default_member_permissions: "0",
      options: ["create", "start", "stop", "pause", "resume"].map((name) => ({
        type: 1,
        name,
        description: "Piloter une manche",
        options: [
          string(
            "id",
            name === "create"
              ? "Identifiant du tournoi"
              : "Identifiant de la manche",
            true,
          ),
        ],
      })),
    },
    {
      name: "player",
      description: "Modération des joueurs",
      default_member_permissions: "0",
      options: [
        {
          type: 1,
          name: "ban",
          description: "Bannir un joueur",
          options: [
            string("discord", "ID Discord", true),
            string("motif", "Motif", true),
          ],
        },
      ],
    },
  ];
  async function apiFor(user, route, body) {
    const session = randomBytes(48).toString("base64url");
    const digest = hash(session);
    await db.query(
      "INSERT INTO sessions VALUES($1,$2,now()+interval '2 minutes')",
      [digest, user.id],
    );
    try {
      const response = await fetch("http://127.0.0.1:3400" + route, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Origin: origin,
          Cookie: "azertix_session=" + session,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const data = response.status === 204 ? null : await response.json();
      if (!response.ok) throw new Error(data?.error ?? "Action refusée");
      return data;
    } finally {
      await db.query("DELETE FROM sessions WHERE token_hash=$1", [digest]);
    }
  }
  async function handle(interaction) {
    if (interaction.guild_id !== guild)
      return "Commande réservée au serveur AzertixYT.";
    const command = interaction.data.name,
      options = interaction.data.options ?? [];
    const sub = options[0]?.type === 1 ? options[0] : null;
    const args = Object.fromEntries(
      (sub?.options ?? options).map((o) => [o.name, o.value]),
    );
    if (command === "tournoi") {
      const t = (
        await db.query(
          "SELECT * FROM tournaments WHERE status IN ('open','closed','running') ORDER BY starts_at LIMIT 1",
        )
      ).rows[0];
      return t
        ? `🏆 ${t.name}\n${new Date(t.starts_at).toLocaleString("fr-FR", { timeZone: "Europe/Paris" })} (Paris)\n${origin}/tournaments#${t.id}`
        : "Aucun tournoi annoncé pour le moment.";
    }
    if (command === "classement") {
      const players = (
        await db.query(
          "SELECT u.username,sum(r.points)::int points FROM results r JOIN users u ON u.id=r.user_id GROUP BY u.id ORDER BY points DESC LIMIT 10",
        )
      ).rows;
      return players.length
        ? players
            .map((p, i) => `${i + 1}. ${p.username} — ${p.points} points`)
            .join("\n")
        : "Le classement attend les premières manches.";
    }
    if (command === "prochaine-partie") {
      const m = (
        await db.query(
          "SELECT m.game_id,t.name FROM matches m JOIN tournaments t ON t.id=m.tournament_id WHERE m.status='lobby' ORDER BY m.created_at DESC LIMIT 1",
        )
      ).rows[0];
      return m
        ? `🎮 ${m.name}\n${origin}/game/${m.game_id}`
        : "Aucune manche en attente.";
    }
    const user = (
      await db.query("SELECT * FROM users WHERE discord_id=$1", [
        interaction.member?.user?.id,
      ])
    ).rows[0];
    if (!user)
      return `Connecte ton compte Discord sur ${origin}/login avant d’utiliser cette commande.`;
    if (isBanned(user)) return "Compte banni.";
    if (command === "profil") return `Ton profil : ${origin}/profile`;
    if (command === "inscription") {
      const id =
        args.tournoi ??
        (
          await db.query(
            "SELECT id FROM tournaments WHERE status='open' ORDER BY starts_at LIMIT 1",
          )
        ).rows[0]?.id;
      if (!id) return "Aucun tournoi ouvert.";
      await apiFor(user, `/tournaments/${encodeURIComponent(id)}/register`, {});
      return `Inscription confirmée ! ${origin}/tournaments#${id}`;
    }
    if (command === "tournament") {
      if (sub.name === "create") {
        const t = await apiFor(user, "/admin/tournaments", {
          name: args.nom,
          startsAt: args.date,
          capacity: args.places ?? 32,
          rounds: args.manches ?? 3,
          rules: "",
          gameConfig: {
            gameMap: "World",
            gameMode: "Free For All",
            bots: 0,
            nations: "disabled",
          },
        });
        return `Tournoi créé : ${t.id}`;
      }
      const status = {
        open: "open",
        close: "closed",
        start: "running",
        end: "finished",
      }[sub.name];
      await apiFor(
        user,
        `/admin/tournaments/${encodeURIComponent(args.id)}/status`,
        { status },
      );
      return "Tournoi mis à jour.";
    }
    if (command === "match") {
      if (sub.name === "create") {
        const m = await apiFor(
          user,
          `/admin/tournaments/${encodeURIComponent(args.id)}/matches`,
          {},
        );
        return `Manche créée : ${m.id}\n${origin}/game/${m.gameId}`;
      }
      await apiFor(
        user,
        `/admin/matches/${encodeURIComponent(args.id)}/action`,
        { action: sub.name === "stop" ? "cancel" : sub.name },
      );
      return "Action appliquée à la manche.";
    }
    if (command === "player") {
      const target = (
        await db.query("SELECT public_id FROM users WHERE discord_id=$1", [
          args.discord,
        ])
      ).rows[0];
      if (!target) return "Joueur introuvable.";
      await apiFor(user, `/admin/users/${target.public_id}/ban`, {
        banned: true,
        until: null,
        reason: args.motif,
      });
      return "Joueur banni.";
    }
    return "Commande inconnue.";
  }
  async function interaction(data) {
    if (data.type !== 2) return;
    await rest(`/interactions/${data.id}/${data.token}/callback`, "POST", {
      type: 5,
      data: { flags: 64 },
    });
    let content;
    try {
      content = await handle(data);
    } catch (error) {
      content = error.message;
    }
    await rest(`/webhooks/${appId}/${data.token}/messages/@original`, "PATCH", {
      content: content.slice(0, 1900),
      allowed_mentions: { parse: [] },
    });
  }
  function reconnect() {
    clearInterval(heartbeat);
    if (stopped) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => connect().catch(reconnect), 10000);
    retryTimer.unref();
  }
  async function connect() {
    const gateway = await rest("/gateway/bot");
    sequence = null;
    ack = true;
    socket = new WebSocket(gateway.url + "?v=10&encoding=json");
    socket.addEventListener("message", (event) => {
      const packet = JSON.parse(event.data);
      if (packet.s !== null) sequence = packet.s;
      if (packet.op === 10) {
        const beat = () => {
          if (!ack) {
            socket.close();
            return;
          }
          ack = false;
          socket.send(JSON.stringify({ op: 1, d: sequence }));
        };
        heartbeat = setInterval(beat, packet.d.heartbeat_interval);
        heartbeat.unref();
        socket.send(
          JSON.stringify({
            op: 2,
            d: {
              token,
              intents: 1,
              properties: {
                os: "linux",
                browser: "AzertixYT",
                device: "AzertixYT",
              },
            },
          }),
        );
      }
      if (packet.op === 11) ack = true;
      if (packet.op === 1) {
        ack = false;
        socket.send(JSON.stringify({ op: 1, d: sequence }));
      }
      if (packet.op === 7 || packet.op === 9) socket.close();
      if (packet.t === "INTERACTION_CREATE")
        interaction(packet.d).catch(() =>
          console.error("Discord command response failed"),
        );
    });
    socket.addEventListener("close", reconnect);
    socket.addEventListener("error", () => socket.close());
  }
  rest(`/applications/${appId}/guilds/${guild}/commands`, "PUT", commands)
    .then(connect)
    .catch(() => {
      console.error("Discord bot configuration failed");
      reconnect();
    });
  let publishing = false;
  const announcements = setInterval(async () => {
    if (publishing || !env.DISCORD_ANNOUNCEMENT_CHANNEL_ID) return;
    publishing = true;
    try {
      const result = await db.query(
        "SELECT * FROM announcements WHERE delivered_at IS NULL AND attempts<5 AND next_attempt<now() ORDER BY id LIMIT 1",
      );
      const item = result.rows[0];
      if (!item) return;
      try {
        await rest(
          `/channels/${env.DISCORD_ANNOUNCEMENT_CHANNEL_ID}/messages`,
          "POST",
          { content: item.content, allowed_mentions: { parse: [] } },
        );
        await db.query(
          "UPDATE announcements SET delivered_at=now() WHERE id=$1",
          [item.id],
        );
      } catch {
        await db.query(
          "UPDATE announcements SET attempts=attempts+1,next_attempt=now()+interval '5 minutes' WHERE id=$1",
          [item.id],
        );
      }
    } catch {
      console.error("Discord announcement worker failed");
    } finally {
      publishing = false;
    }
  }, 15000);
  announcements.unref();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      stopped = true;
      clearInterval(heartbeat);
      clearInterval(announcements);
      clearTimeout(retryTimer);
      socket?.close();
    });
}
