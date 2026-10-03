import { openRoomConfigurator } from "./room-config.js";
const nonEmpty = (value, fallback) => (value.length > 0 ? value : fallback);
const base = "/platform-api";
const app = document.querySelector("#app");
const $ = (selector, root = document) => root.querySelector(selector);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const date = (value) =>
  new Date(value).toLocaleString("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Paris",
  });
const status = {
  draft: "Brouillon",
  open: "Inscriptions ouvertes",
  closed: "Inscriptions fermées",
  running: "En cours",
  finished: "Terminé",
  lobby: "Lobby",
  paused: "En pause",
  cancelled: "Annulée",
};
let me = null,
  config = null,
  currentTab = "rooms",
  poll;
async function api(path, body) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw Object.assign(new Error(data.error ?? "Service indisponible"), {
      status: response.status,
    });
  }
  return response.status === 204 ? null : response.json();
}
function notice(text) {
  const n = $("#notice");
  n.textContent = text;
  n.style.display = "block";
  clearTimeout(n.timer);
  n.timer = setTimeout(() => (n.style.display = "none"), 5500);
}
function button(label, action, secondary = true) {
  return `<button class="${secondary ? "secondary " : ""}small" data-action="${esc(action)}">${esc(label)}</button>`;
}
const pill = (s) =>
  `<span class="pill status-${esc(s)}">${esc(status[s] ?? s)}</span>`;
const hero = (title, description, eyebrow = "AZERTIXYT · OPENFRONT") =>
  `<section class="hero"><span class="eyebrow">${esc(eyebrow)}</span><h1>${esc(title)}</h1><p class="subtitle">${esc(description)}</p></section>`;
const empty = (text) => `<div class="empty">${esc(text)}</div>`;
const table = (headers, rows) =>
  `<div class="table-wrap"><table><thead><tr>${headers.map((x) => `<th>${esc(x)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
function dialog(title, html, onSubmit) {
  const d = document.createElement("dialog");
  d.innerHTML = `<form><div class="row spread"><h2>${esc(title)}</h2><button type="button" class="secondary small" id="close">Fermer</button></div>${html}<p class="error" id="form-error"></p><button type="submit">Enregistrer</button></form>`;
  document.body.append(d);
  $("#close", d).onclick = () => d.close();
  d.addEventListener("close", () => d.remove());
  $("form", d).onsubmit = async (event) => {
    event.preventDefault();
    const submit = $("[type=submit]", d);
    submit.disabled = true;
    try {
      await onSubmit(new FormData(event.target));
      d.close();
      notice("Enregistré");
      await renderAdmin();
    } catch (error) {
      $("#form-error", d).textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  };
  d.showModal();
}
async function tournaments() {
  const [tournaments, leaders] = await Promise.all([
    api("/tournaments"),
    api("/leaderboard"),
  ]);
  app.innerHTML =
    hero(
      "Le prochain territoire à conquérir.",
      "Retrouve les tournois de la communauté, rejoins une compétition et suis les résultats de chaque manche.",
    ) +
    `<div class="row spread"><h2>Les tournois</h2><a class="button secondary small" href="/">Ouvrir le jeu →</a></div><div class="grid">${nonEmpty(tournaments.map((t) => `<article class="card ${t.status === "open" ? "feature" : ""}"><div class="row spread">${pill(t.status)}<span class="muted">${t.rounds} manche${t.rounds > 1 ? "s" : ""}</span></div><h2 style="margin-top:20px">${esc(t.name)}</h2><p class="muted">${date(t.starts_at)}</p><div class="meta"><span>${t.registered} / ${t.capacity} inscrits</span><span>Victoire 10 pts</span></div><button data-tournament="${esc(t.id)}">Voir le tournoi →</button></article>`).join(""), empty("Le prochain tournoi sera annoncé ici."))}</div><h2>Classement de la communauté</h2>${
      leaders.length
        ? table(
            ["#", "Joueur", "Points", "Victoires", "Parties"],
            leaders.map(
              (p, i) =>
                `<tr><td>${i + 1}</td><td>${esc(p.username)}</td><td>${p.points}</td><td>${p.wins}</td><td>${p.games}</td></tr>`,
            ),
          )
        : empty(
            "Le classement apparaîtra après les premières manches terminées.",
          )
    }`;
  for (const b of app.querySelectorAll("[data-tournament]"))
    b.onclick = () => {
      location.hash = b.dataset.tournament;
      showTournament(b.dataset.tournament).catch((error) =>
        notice(error.message),
      );
    };
  if (location.hash) await showTournament(location.hash.slice(1));
}
async function showTournament(id) {
  const t = await api("/tournaments/" + encodeURIComponent(id));
  const d = document.createElement("dialog");
  d.innerHTML = `<div class="row spread"><h2>${esc(t.name)}</h2><button class="secondary small" id="close">Fermer</button></div>${pill(t.status)}<p>${date(t.starts_at)} · ${t.capacity} places · ${t.rounds} manches</p><p class="detail muted">${esc(t.rules) || "Victoire : 10 points. Participation à une manche terminée : 1 point. Les parties annulées ne rapportent aucun point."}</p>${t.status === "open" ? `<div class="row"><button id="register">M’inscrire avec Discord</button><button class="secondary" id="unregister">Me désinscrire</button></div>` : ""}<h3 style="margin-top:25px">Manches</h3>${nonEmpty(t.matches.map((m) => `<div class="row spread card">Manche ${m.round} ${pill(m.status)}<a class="button small secondary" href="/game/${esc(m.game_id)}">Rejoindre</a></div>`).join(""), empty("Les lobbies seront créés au démarrage du tournoi."))}<h3 style="margin-top:20px">Participants & classement</h3>${table(
    ["Joueur", "Points", "Victoires"],
    t.standings.map(
      (p) =>
        `<tr><td>${esc(p.username)}</td><td>${p.points}</td><td>${p.wins}</td></tr>`,
    ),
  )}`;
  document.body.append(d);
  $("#close", d).onclick = () => d.close();
  d.onclose = () => {
    d.remove();
    history.replaceState(null, "", location.pathname);
  };
  for (const action of ["register", "unregister"]) {
    const b = $("#" + action, d);
    if (b)
      b.onclick = async () => {
        b.disabled = true;
        try {
          if (!me) {
            location.href = "/login";
            return;
          }
          await api(`/tournaments/${id}/${action}`, {});
          notice(
            action === "register"
              ? "Inscription confirmée"
              : "Inscription retirée",
          );
          d.close();
          await tournaments();
        } catch (error) {
          notice(error.message);
        } finally {
          b.disabled = false;
        }
      };
  }
  d.showModal();
}
function login(
  mode = location.pathname.startsWith("/admin") ? "owner" : "code",
) {
  const code = new URLSearchParams(location.search).get("code") ?? "";
  app.innerHTML = `<section class="card login"><a class="back-link" href="/">← Retour au jeu</a><h1>${mode === "owner" ? "Connexion organisateur" : "Rejoindre un salon"}</h1><p class="muted">${mode === "owner" ? "Crée tes parties et partage un code avec les joueurs." : "Ton pseudo, le code de l’organisateur, et c’est parti."}</p><div class="tabs login-tabs"><button class="${mode === "code" ? "active" : ""}" data-login="code">Jouer avec un code</button><button class="${mode === "owner" ? "active" : ""}" data-login="owner">Organisateur</button></div>${mode === "owner" ? `<form id="owner-form"><label>Clé propriétaire<input name="key" type="password" autocomplete="current-password" required minlength="16" placeholder="Ta clé personnelle"></label><p class="error" id="login-error" role="alert"></p><button type="submit" ${config.ownerReady ? "" : "disabled"}>Ouvrir l’administration</button>${config.ownerReady ? '<p class="form-help">Ta clé est privée. Ne partage que les codes des salons.</p>' : '<p class="form-help">La connexion propriétaire est en cours d’activation.</p>'}</form>` : `<form id="code-form"><label>Pseudo<input name="username" autocomplete="nickname" required minlength="2" maxlength="24" placeholder="Ton pseudo" value="${esc(me?.username ?? "")}"></label><label>Code du salon<input class="code-input" name="code" autocomplete="off" spellcheck="false" required minlength="8" maxlength="9" placeholder="ABCD2345" value="${esc(code)}"></label><p class="error" id="login-error" role="alert"></p><button type="submit">Rejoindre la partie</button><p class="form-help">Le code est fourni par l’organisateur. Aucun compte Discord nécessaire.</p></form>`}${config.discordReady ? '<div class="login-divider"><span>ou</span></div><a class="button secondary discord-button" href="/platform-api/auth/login/discord">Continuer avec Discord</a>' : ""}</section>`;
  for (const b of app.querySelectorAll("[data-login]"))
    b.onclick = () => login(b.dataset.login);
  const form = $(mode === "owner" ? "#owner-form" : "#code-form");
  form.onsubmit = async (event) => {
    event.preventDefault();
    const submit = $("[type=submit]", form);
    submit.disabled = true;
    $("#login-error").textContent = "";
    try {
      const data = new FormData(form);
      if (mode === "owner") {
        await api("/auth/owner", { key: data.get("key") });
        location.href = "/admin";
      } else {
        const result = await api("/auth/code", {
          username: data.get("username"),
          code: String(data.get("code")).replace(/[\s-]/g, "").toUpperCase(),
        });
        location.href = "/game/" + encodeURIComponent(result.gameId);
      }
    } catch (error) {
      $("#login-error").textContent = error.message;
      submit.disabled = false;
    }
  };
}
function historyTable(rows) {
  return table(
    ["Tournoi", "Manche", "Résultat", "Points", "Date"],
    rows.map(
      (r) =>
        `<tr><td>${esc(r.name)}</td><td>${esc(r.round ?? "—")}</td><td>${r.winner ? "Victoire" : "Participation"}</td><td>${r.points}</td><td>${date(r.created_at)}</td></tr>`,
    ),
  );
}
async function profile() {
  if (!me) {
    login();
    return;
  }
  app.innerHTML =
    hero(
      me.username,
      "Tes parties, tes résultats et tes salons.",
      "MON PROFIL",
    ) +
    `<div class="grid">${[
      ["Points", me.points],
      ["Victoires", me.wins],
      ["Parties jouées", me.games],
    ]
      .map(
        ([name, value]) =>
          `<div class="card"><span class="muted">${name}</span><div class="metric">${value}</div></div>`,
      )
      .join(
        "",
      )}</div><div class="card profile-account"><div class="profile-initial">${esc(me.username.slice(0, 1).toUpperCase())}</div><div><h2>${esc(me.username)}</h2><span class="pill">${me.provider === "owner" ? "Organisateur" : me.provider === "guest" ? "Joueur · Accès par code" : "Compte Discord"}</span><p class="muted">Membre depuis le ${date(me.createdAt)}</p></div><button class="secondary small" id="logout">Se déconnecter</button></div>`;
  if (["SUPER_ADMIN", "TOURNAMENT_ADMIN"].includes(me.role))
    app.insertAdjacentHTML(
      "beforeend",
      '<a class="button" href="/admin">Gérer mes salons →</a>',
    );
  const rooms = await api("/me/rooms");
  app.insertAdjacentHTML(
    "beforeend",
    `<section class="card"><h2>Mes salons</h2>${rooms.length ? rooms.map((r) => `<div class="row spread profile-room"><div><strong>${esc(r.name)}</strong> ${pill(r.status)}</div>${["lobby", "running", "paused"].includes(r.status) ? `<a class="button secondary small" href="/game/${esc(r.game_id)}">Rejoindre</a>` : ""}</div>`).join("") : '<p class="muted">Rejoins ton premier salon avec le code de l’organisateur.</p><a class="button secondary small" href="/login">Entrer un code</a>'}</section>`,
  );
  app.insertAdjacentHTML(
    "beforeend",
    `<div class="card"><h2>Historique des manches</h2>${historyTable(await api("/me/history"))}</div>`,
  );
  $("#logout").onclick = async () => {
    await api("/auth/logout", {});
    location.href = "/login";
  };
}
async function renderAdmin() {
  clearInterval(poll);
  if (!me || me.role === "PLAYER") {
    login("owner");
    return;
  }
  app.innerHTML =
    hero(
      "Administration",
      "Crée un salon, partage son code et lance la partie quand tout le monde est prêt.",
      "ADMINISTRATION",
    ) +
    `<div class="tabs">${[
      ["rooms", "Mes salons"],
      ["live", "Live"],
      ["tournaments", "Tournois"],
      ["matches", "Parties"],
      ["users", "Joueurs"],
      ["logs", "Journal"],
      ["settings", "Réglages"],
    ]
      .filter(([key]) => key !== "logs" || me.role === "SUPER_ADMIN")
      .map(
        ([key, label]) =>
          `<button data-tab="${key}" class="${key === currentTab ? "active" : ""}">${label}</button>`,
      )
      .join("")}</div><section id="content">Chargement…</section>`;
  for (const b of app.querySelectorAll("[data-tab]"))
    b.onclick = () => {
      currentTab = b.dataset.tab;
      renderAdmin().catch((e) => notice(e.message));
    };
  const content = $("#content");
  try {
    await adminContent(content);
    if (currentTab === "live")
      poll = setInterval(
        () => adminContent(content).catch((e) => notice(e.message)),
        15000,
      );
  } catch (error) {
    content.innerHTML = empty(error.message);
  }
}
async function adminContent(content) {
  if (currentTab === "rooms") {
    const rooms = await api("/admin/rooms");
    const manage = ["SUPER_ADMIN", "TOURNAMENT_ADMIN"].includes(me.role);
    content.innerHTML = `<div class="row spread section-heading"><h2>Mes salons</h2>${manage ? button("+ Créer un salon", "room-create", false) : ""}</div>${rooms.length ? `<div class="grid rooms-grid">${rooms.map((r) => `<article class="card room-card"><div class="row spread"><h3>${esc(r.name)}</h3>${pill(r.status)}</div><p class="muted">${esc(r.config.gameMap)} · ${r.config.gameMode === "Team" ? "Équipes · " + esc(r.config.playerTeams) : "Chacun pour soi"} · ${r.registered} / ${r.capacity} joueurs inscrits</p>${roomSettings(r.config)}<div class="room-code"><span>Code à partager</span><strong>${esc(r.code)}</strong><div class="row">${button("Copier le code", `copy-code:${r.code}`)}${button("Copier le lien", `copy-link:${r.code}`)}</div></div><div class="row room-actions"><a class="button secondary small" href="/game/${esc(r.game_id)}">Jouer</a>${["lobby", "running", "paused"].includes(r.status) ? button("Voir les joueurs", `room-players:${r.id}`) : ""}${manage && r.status === "lobby" ? button("Démarrer", `room-action:${r.id}:start`, false) : ""}${manage && r.status === "running" ? button("Pause", `room-action:${r.id}:pause`) : ""}${manage && r.status === "paused" ? button("Reprendre", `room-action:${r.id}:resume`, false) : ""}${manage && ["lobby", "running", "paused"].includes(r.status) ? button("Fermer", `room-action:${r.id}:cancel`) : ""}</div></article>`).join("")}</div>` : `<div class="empty"><h3>Ton premier salon</h3><p>Choisis une carte, crée le salon, puis donne le code aux joueurs.</p>${manage ? button("Créer un salon", "room-create", false) : ""}</div>`}`;
  }
  if (currentTab === "live") {
    const data = await api("/admin/live");
    content.innerHTML = `<div class="grid">${[
      ["Joueurs dans les parties", data.connections.players],
      ["Connexions WebSocket", data.connections.webSockets],
      ["Parties sur le serveur", data.connections.games],
      ["Comptes", data.users],
      ["Sessions actives", data.sessions],
      ["Manches actives", data.active_matches],
      ["Latence du jeu", data.latencyMs + " ms"],
    ]
      .map(
        ([name, value]) =>
          `<div class="card"><span class="muted">${name}</span><div class="metric">${value}</div></div>`,
      )
      .join(
        "",
      )}</div><div class="card"><div class="row spread"><h2>État de la plateforme</h2><span class="pill">Jeu disponible</span></div><p>API : ${Math.round(data.memoryBytes / 1024 / 1024)} Mo de mémoire · en ligne depuis ${Math.floor(data.uptimeSeconds / 60)} min</p><p class="muted">Hôte : charge 1 min ${data.host.loadAverage[0].toFixed(2)} · ${data.host.cpuCount} CPU · mémoire libre ${Math.round(data.host.memoryFreeBytes / 1024 / 1024)} Mo</p><p class="muted">Discord : ${data.discord ? "configuré" : "en attente"} · Bot : ${data.bot ? "configuré" : "en attente"}</p><p class="muted">Version <code>${esc((data.release ?? "").slice(0, 12))}</code></p></div>`;
    return;
  }
  if (currentTab === "tournaments") {
    const data = await api("/tournaments");
    content.innerHTML = `<div class="row spread"><h2>Tournois</h2>${button("Créer un tournoi", "create")}</div>${nonEmpty(
      data
        .map(
          (t) =>
            `<div class="card"><div class="row spread"><h3>${esc(t.name)}</h3>${pill(t.status)}</div><p class="muted">${date(t.starts_at)} · ${t.registered}/${t.capacity} joueurs · ${t.rounds} manches</p>${roomSettings(t.game_config ?? {})}<div class="row">${(
              {
                draft: [["Ouvrir les inscriptions", "open"]],
                open: [["Fermer les inscriptions", "closed"]],
                closed: [
                  ["Rouvrir", "open"],
                  ["Démarrer le tournoi", "running"],
                ],
                running: [["Terminer le tournoi", "finished"]],
                finished: [],
              }[t.status] ?? []
            )
              .map(([label, s]) => button(label, `status:${t.id}:${s}`))
              .join(
                "",
              )}${t.status === "running" ? button("Créer la prochaine manche", `match:${t.id}`) : ""}</div></div>`,
        )
        .join(""),
      empty("Aucun tournoi pour le moment."),
    )}`;
  }
  if (currentTab === "matches") {
    const data = await api("/admin/matches");
    content.innerHTML = `<h2>Parties de tournoi</h2>${nonEmpty(data.map((m) => `<div class="card"><div class="row spread"><h3>${esc(m.name)} · Manche ${m.round}</h3>${pill(m.status)}</div><p class="muted">Code <code>${esc(m.game_id)}</code></p><div class="row"><a class="button small secondary" href="/game/${esc(m.game_id)}">Ouvrir le lobby</a>${button("Joueurs", `roster:${m.id}`)}${m.status === "cancelled" ? button("Recréer cette manche", `restart:${m.id}`) : ""}${m.status === "lobby" ? button("Démarrer", `action:${m.id}:start`) : ""}${m.status === "running" ? button("Mettre en pause", `action:${m.id}:pause`) : ""}${m.status === "paused" ? button("Reprendre", `action:${m.id}:resume`) : ""}${!["finished", "cancelled"].includes(m.status) ? button("Annuler", `action:${m.id}:cancel`) : ""}</div></div>`).join(""), empty("Crée une manche depuis un tournoi en cours."))}`;
  }
  if (currentTab === "users") {
    content.innerHTML =
      '<h2>Joueurs</h2><label>Rechercher par pseudo ou ID Discord<input id="search" placeholder="Rechercher…"></label><div id="users"></div>';
    let timer;
    $("#search", content).oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          loadUsers($("#users", content), $("#search", content).value).catch(
            (e) => notice(e.message),
          ),
        300,
      );
    };
    await loadUsers($("#users", content), "");
  }
  if (currentTab === "logs") {
    const data = await api("/admin/logs");
    content.innerHTML = `<h2>Journal d’administration</h2>${table(
      ["Date", "Compte", "Action", "Cible"],
      data.map(
        (l) =>
          `<tr><td>${date(l.created_at)}</td><td>${esc(l.username ?? "Serveur de jeu")}</td><td>${esc(l.action)}</td><td><code>${esc(l.target)}</code></td></tr>`,
      ),
    )}`;
  }
  if (currentTab === "settings") {
    content.innerHTML = `<div class="card"><h2>Discord</h2><p>${config.discordReady ? "La connexion Discord est configurée." : "La connexion attend les identifiants de l’application Discord."}</p><p class="muted">Serveur : <code>${esc(config.guildId ?? "À configurer")}</code></p><p class="muted">Les membres du serveur sont vérifiés lors des inscriptions et du renouvellement des sessions de jeu.</p></div><div class="card"><h2>Hébergement</h2><p>La plateforme et le serveur de jeu tournent sur le VPS. Le dépôt GitHub fournit les versions déployées.</p><p class="muted">Les résultats sont reçus automatiquement. Une victoire rapporte 10 points ; une participation à une manche terminée rapporte 1 point.</p></div>`;
  }
  for (const b of content.querySelectorAll("[data-action]"))
    b.onclick = () =>
      doAction(b.dataset.action).catch((e) => notice(e.message));
}
function roomSettings(c) {
  const difficulty = {
    Easy: "Facile",
    Medium: "Moyenne",
    Hard: "Difficile",
    Impossible: "Impossible",
  };
  const teams = {
    Duos: "Duos",
    Trios: "Trios",
    Quads: "Escouades",
    "Humans Vs Nations": "Humains contre nations",
  };
  const mode =
    c.gameMode === "Team"
      ? (teams[c.playerTeams] ?? `${c.playerTeams} équipes`)
      : "Chacun pour soi";
  const options = [
    [c.randomSpawn, "Apparition aléatoire"],
    [c.infiniteGold, "Or illimité"],
    [c.infiniteTroops, "Troupes illimitées"],
    [c.instantBuild, "Construction instantanée"],
    [c.waterNukes, "Nucléaire sur l’eau"],
  ]
    .filter(([enabled]) => enabled)
    .map(([, label]) => label);
  return `<details class="room-settings"><summary>Réglages de la partie</summary><p>${esc(mode)} · ${esc(difficulty[c.difficulty] ?? "Facile")} · ${c.gameMapSize === "Compact" ? "Terrain compact" : "Terrain normal"}</p><p>${esc(c.bots)} bots · Nations : ${esc(c.nations === "disabled" ? "désactivées" : c.nations === "default" ? "celles de la carte" : c.nations)}</p><p>Or : ×${esc(c.goldMultiplier ?? 1)} · Départ : ${esc(c.startingGold ?? 0)}</p>${options.length ? `<p>${esc(options.join(" · "))}</p>` : ""}${c.maxTimerValue ? `<p>Durée maximale : ${esc(c.maxTimerValue)} minutes</p>` : ""}${c.customAllianceDuration !== null && c.customAllianceDuration !== undefined ? `<p>Alliances : ${esc(c.customAllianceDuration)} minutes</p>` : ""}${c.doomsdayClock?.enabled ? `<p>Horloge : ${esc(c.doomsdayClock.speed)}</p>` : ""}${c.overtime?.enabled ? `<p>Prolongations après ${esc(c.overtime.startMinutes)} minutes</p>` : ""}${c.disabledUnits?.length ? `<p>Unités désactivées : ${esc(c.disabledUnits.join(", "))}</p>` : ""}</details>`;
}
async function loadUsers(target, q) {
  const users = await api("/admin/users?q=" + encodeURIComponent(q));
  target.innerHTML = table(
    ["Joueur", "Compte", "Rôle", "Modération"],
    users.map(
      (u) =>
        `<tr><td>${esc(u.username)} ${button("Historique", `history:${u.public_id}`)}</td><td>${u.auth_provider === "guest" ? "Invité · Code" : u.auth_provider === "owner" ? "Propriétaire" : esc(u.discord_id)}</td><td>${esc(u.role)} ${me.role === "SUPER_ADMIN" && u.auth_provider === "discord" ? button("Modifier", `role:${u.public_id}`) : ""}</td><td>${u.role !== "SUPER_ADMIN" ? button(u.banned ? "Lever le ban" : "Bannir", `ban:${u.public_id}:${u.banned ? "false" : "true"}`) : ""}</td></tr>`,
    ),
  );
  for (const b of target.querySelectorAll("[data-action]"))
    b.onclick = () =>
      doAction(b.dataset.action).catch((e) => notice(e.message));
}
async function doAction(action) {
  const [type, id, value] = action.split(":");
  if (type === "copy-code" || type === "copy-link") {
    const text =
      type === "copy-code"
        ? id
        : location.origin + "/login?code=" + encodeURIComponent(id);
    try {
      await navigator.clipboard.writeText(text);
      notice(type === "copy-code" ? "Code copié" : "Lien copié");
    } catch {
      notice(text);
    }
    return;
  }
  if (type === "room-create") {
    await openRoomConfigurator({
      create: (settings) => api("/admin/rooms", settings),
      onCreated: renderAdmin,
      notice,
    });
    return;
  }
  if (type === "room-action") {
    if (value === "cancel") {
      dialog(
        "Fermer le salon",
        "<p>Les joueurs seront déconnectés et ce code ne permettra plus de rejoindre.</p>",
        () => api(`/admin/rooms/${id}/action`, { action: "cancel" }),
      );
      return;
    }
    await api(`/admin/rooms/${id}/action`, { action: value });
    await renderAdmin();
    notice(value === "start" ? "La partie démarre" : "Action effectuée");
    return;
  }
  if (type === "room-players") {
    const roster = await api(`/admin/rooms/${id}/players`);
    const d = document.createElement("dialog");
    const manage = ["SUPER_ADMIN", "TOURNAMENT_ADMIN"].includes(me.role);
    d.innerHTML = `<div class="row spread"><h2>Joueurs du salon</h2><button class="secondary small" id="close">Fermer</button></div>${
      roster.players.length
        ? table(
            ["Pseudo", "Statut", ""],
            roster.players.map(
              (p) =>
                `<tr><td>${esc(p.username)}</td><td>${p.spectator ? "Spectateur" : "Joueur"}</td><td>${manage ? button("Exclure", `kick:${p.clientID}`) : ""}</td></tr>`,
            ),
          )
        : empty(
            "Les joueurs apparaîtront ici après avoir rejoint avec le code.",
          )
    }`;
    document.body.append(d);
    $("#close", d).onclick = () => d.close();
    d.onclose = () => d.remove();
    for (const b of d.querySelectorAll("[data-action]"))
      b.onclick = async () => {
        b.disabled = true;
        try {
          await api(`/admin/rooms/${id}/action`, {
            action: "kick",
            clientId: b.dataset.action.split(":")[1],
          });
          d.close();
          notice("Joueur exclu");
        } catch (error) {
          notice(error.message);
          b.disabled = false;
        }
      };
    d.showModal();
    return;
  }
  if (type === "create") {
    await openRoomConfigurator({
      kind: "tournament",
      create: (settings) =>
        api("/admin/tournaments", {
          ...settings,
          startsAt: parisToISO(settings.startsAt),
        }),
      onCreated: renderAdmin,
      notice,
    });
    return;
  }
  if (type === "history") {
    const data = await api(`/admin/users/${id}/history`);
    dialog(
      `Historique de ${data.username}`,
      historyTable(data.history),
      async () => {},
    );
    return;
  }
  if (type === "restart") {
    dialog(
      "Recréer cette manche",
      "<p>Un nouveau code de lobby sera généré pour cette manche annulée.</p>",
      () => api(`/admin/matches/${id}/restart`, {}),
    );
    return;
  }
  if (type === "status")
    await api(`/admin/tournaments/${id}/status`, { status: value });
  if (type === "match") await api(`/admin/tournaments/${id}/matches`, {});
  if (type === "action") {
    if (value === "cancel") {
      dialog(
        "Annuler la partie",
        "<p>Cette manche sera fermée sans attribuer de points.</p>",
        () => api(`/admin/matches/${id}/action`, { action: value }),
      );
      return;
    }
    await api(`/admin/matches/${id}/action`, { action: value });
  }
  if (type === "roster") {
    const data = await api(`/admin/matches/${id}/roster`);
    dialog(
      "Joueurs du lobby",
      `<div id="roster">${nonEmpty((data.players ?? []).map((p) => `<p>${esc(p.username ?? p.clientID)} <button type="button" class="small secondary" data-kick="${esc(p.clientID)}">Exclure</button></p>`).join(""), empty("Aucun joueur connecté."))}</div>`,
      async () => {},
    );
    for (const b of document.querySelectorAll("[data-kick]"))
      b.onclick = async () => {
        try {
          await api(`/admin/matches/${id}/action`, {
            action: "kick",
            clientId: b.dataset.kick,
          });
          b.closest("p").remove();
          notice("Joueur exclu");
        } catch (e) {
          notice(e.message);
        }
      };
    return;
  }
  if (type === "ban") {
    dialog(
      value === "true" ? "Bannir un joueur" : "Lever le ban",
      '<label>Motif<textarea name="reason" maxlength="500"></textarea></label><label>Durée<select name="hours"><option value="24">24 heures</option><option value="168">7 jours</option><option value="0">Permanent</option></select></label>',
      async (data) =>
        api(`/admin/users/${id}/ban`, {
          banned: value === "true",
          reason: data.get("reason"),
          until: Number(data.get("hours"))
            ? new Date(
                Date.now() + Number(data.get("hours")) * 3600000,
              ).toISOString()
            : null,
        }),
    );
    return;
  }
  if (type === "role") {
    dialog(
      "Rôle du joueur",
      '<label>Rôle<select name="role"><option>PLAYER</option><option>MODERATOR</option><option>TOURNAMENT_ADMIN</option><option>SUPER_ADMIN</option></select></label>',
      async (data) =>
        api(`/admin/users/${id}/role`, { role: data.get("role") }),
    );
    return;
  }
  notice("Action effectuée");
  await renderAdmin();
}
function parisToISO(local) {
  const parts = local.split(/[-T:]/).map(Number);
  const target = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4]);
  let result = target;
  for (let i = 0; i < 3; i++) {
    const represented = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Paris",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(new Date(result));
    const p = represented.split(/[- :]/).map(Number);
    const shown = Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4], p[5]);
    result += target - shown;
  }
  return new Date(result).toISOString();
}
try {
  [config, me] = await Promise.all([
    api("/config"),
    api("/me").catch((e) => {
      if (e.status === 401 || e.status === 403) return null;
      throw e;
    }),
  ]);
  if (/^[a-f0-9]{40}$/.test(config.release ?? ""))
    $("#source-code").href =
      `https://github.com/Baptiste-Boin/OpenFrontIO/tree/${config.release}`;
  if (me) {
    $("#account").textContent = me.username;
    $("#account").href = "/profile";
  }
  for (const a of document.querySelectorAll("nav a"))
    if (a.pathname === location.pathname) a.classList.add("active");
  if (location.pathname.startsWith("/admin")) await renderAdmin();
  else if (location.pathname.startsWith("/profile")) await profile();
  else if (location.pathname.startsWith("/login")) login();
  else await tournaments();
} catch (error) {
  app.innerHTML =
    hero("La plateforme est indisponible.", error.message) +
    '<button id="retry">Réessayer</button>';
  $("#retry").onclick = () => location.reload();
}
