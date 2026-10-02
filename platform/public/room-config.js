const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const categories = {
  featured: "À la une",
  new: "Nouveautés",
  world: "Mondes",
  continental: "Continents",
  europe: "Europe",
  asia: "Asie",
  north_america: "Amérique du Nord",
  africa: "Afrique",
  south_america: "Amérique du Sud",
  oceania: "Océanie",
  antarctica: "Antarctique",
  countries: "Pays",
  cosmic: "Espace",
  fictional: "Imaginaires",
  arcade: "Arcade",
  tournament: "Tournois",
};
const units = [
  ["City", "Villes"],
  ["Defense Post", "Postes de défense"],
  ["Port", "Ports"],
  ["Warship", "Navires de guerre"],
  ["Transport", "Transports"],
  ["Missile Silo", "Silos à missiles"],
  ["SAM Launcher", "Défenses SAM"],
  ["Atom Bomb", "Bombes atomiques"],
  ["Hydrogen Bomb", "Bombes H"],
  ["MIRV", "MIRV"],
  ["Factory", "Usines"],
];
const select = (name, label, choices) =>
  `<label>${label}<select name="${name}">${choices.map(([value, text]) => `<option value="${esc(value)}">${esc(text)}</option>`).join("")}</select></label>`;
const number = (name, label, value, min, max, step = 1) =>
  `<label>${label}<input name="${name}" type="number" value="${value}" min="${min}" max="${max}" step="${step}" required></label>`;
const toggle = (name, label, checked = false, help = "") =>
  `<label class="setting-toggle"><input type="checkbox" name="${name}" ${checked ? "checked" : ""}><span><strong>${label}</strong>${help ? `<small>${help}</small>` : ""}</span></label>`;
let mapCatalog;
export async function openRoomConfigurator({ create, onCreated, notice }) {
  if (!mapCatalog) {
    const [response, assetResponse] = await Promise.all([
      fetch("/platform-api/ui/maps.json"),
      fetch("/asset-manifest.json"),
    ]);
    if (!response.ok || !assetResponse.ok)
      throw new Error("Impossible de charger les cartes. Réessaie.");
    const [catalog, manifest] = await Promise.all([
      response.json(),
      assetResponse.json(),
    ]);
    mapCatalog = catalog.map((map) => ({
      ...map,
      thumbnail: manifest[map.thumbnail.slice(1)] ?? map.thumbnail,
    }));
  }
  let selected = mapCatalog.find((map) => map.value === "World");
  const d = document.createElement("dialog");
  d.className = "room-configurator";
  d.setAttribute("aria-labelledby", "room-config-title");
  d.innerHTML = `<form>
    <header class="config-header"><div><span class="eyebrow">SALON PRIVÉ</span><h2 id="room-config-title">Préparer la partie</h2><p class="muted">Choisis ton terrain et les règles, puis partage le code.</p></div><button type="button" class="secondary small" data-close>Fermer</button></header>
    <div class="config-layout"><div class="config-main">
    <section class="config-section"><h3>01 · Le salon</h3><div class="fields"><label>Nom du salon<input name="name" required minlength="2" maxlength="80" placeholder="Partie de la communauté"></label>${number("capacity", "Places pour les joueurs", 20, 2, 200)}</div></section>
    <section class="config-section"><div class="row spread"><h3>02 · La carte</h3><span class="muted" data-map-count></span></div><div class="map-filters"><label>Rechercher une carte<input type="search" data-search placeholder="Monde, France, Japon…"></label><label>Catégorie<select data-category><option value="">Toutes les cartes</option>${Object.entries(
      categories,
    )
      .map(([key, text]) => `<option value="${key}">${text}</option>`)
      .join(
        "",
      )}</select></label></div><div class="config-map-grid" role="group" aria-label="Cartes disponibles"></div><input type="hidden" name="map" value="World"></section>
    <section class="config-section"><h3>03 · Mode de jeu</h3><div class="mode-cards" role="group" aria-label="Mode de jeu"><button type="button" data-mode="Free For All" aria-pressed="true"><strong>Chacun pour soi</strong><small>Chaque joueur défend son territoire.</small></button><button type="button" data-mode="Team" aria-pressed="false"><strong>En équipes</strong><small>Un territoire à conquérir ensemble.</small></button></div><input name="gameMode" type="hidden" value="Free For All"><div data-team-options hidden>${select(
      "playerTeams",
      "Format des équipes",
      [
        [2, "2 équipes"],
        [3, "3 équipes"],
        [4, "4 équipes"],
        [5, "5 équipes"],
        [6, "6 équipes"],
        [7, "7 équipes"],
        [8, "8 équipes"],
        ["Duos", "Duos · 2 joueurs par équipe"],
        ["Trios", "Trios · 3 joueurs par équipe"],
        ["Quads", "Escouades · 4 joueurs par équipe"],
        ["Humans Vs Nations", "Humains contre nations"],
      ],
    )}<div class="toggle-grid">${toggle("donateGold", "Dons d’or", true)}${toggle("donateTroops", "Dons de troupes", true)}</div></div></section>
    <section class="config-section"><h3>04 · Adversaires et terrain</h3><div class="fields">${select(
      "difficulty",
      "Difficulté des nations",
      [
        ["Easy", "Facile"],
        ["Medium", "Moyenne"],
        ["Hard", "Difficile"],
        ["Impossible", "Impossible"],
      ],
    )}${number("bots", "Tribus (bots)", 100, 0, 400)}${select(
      "nations",
      "Nations",
      [
        ["default", "Nations de la carte"],
        ["disabled", "Désactivées"],
        ["custom", "Nombre personnalisé"],
      ],
    )}<div data-nation-count hidden>${number("nationCount", "Nombre de nations", 20, 1, 400)}</div>${select(
      "gameMapSize",
      "Taille du terrain",
      [
        ["Normal", "Normale"],
        ["Compact", "Compacte"],
      ],
    )}</div><p class="form-help" data-nation-help></p>${toggle("randomSpawn", "Apparition aléatoire", false, "Le jeu choisit les positions de départ.")}</section>
    <details class="config-section advanced-settings"><summary>Réglages avancés</summary><p class="form-help">Ces options s’appliquent à tous les joueurs du salon.</p><div class="toggle-grid">${toggle("infiniteGold", "Or illimité")}${toggle("infiniteTroops", "Troupes illimitées")}${toggle("instantBuild", "Construction instantanée")}${toggle("waterNukes", "Bombes nucléaires sur l’eau")}</div><div class="fields">${number("goldMultiplier", "Multiplicateur d’or", 1, 0.1, 1000, 0.1)}${number("startingGold", "Or de départ", 0, 0, 1000000000)}${select(
      "allianceMode",
      "Durée des alliances",
      [
        ["default", "Durée classique"],
        ["custom", "Durée personnalisée"],
      ],
    )}<div data-alliance-duration hidden>${number("customAllianceDuration", "Durée (minutes, 0 = désactivées)", 5, 0, 15)}</div></div><div class="toggle-grid">${toggle("maxTimer", "Limiter la durée de partie")}${toggle("doomsday", "Horloge de fin du monde")}${toggle("overtime", "Prolongations")}</div><div class="fields"><div data-timer hidden>${number("maxTimerValue", "Durée maximale (minutes)", 30, 1, 120)}</div><div data-doomsday hidden>${select(
      "doomsdaySpeed",
      "Vitesse de l’horloge",
      [
        ["slow", "Lente"],
        ["normal", "Normale"],
        ["fast", "Rapide"],
        ["veryfast", "Très rapide"],
      ],
    )}</div><div data-overtime hidden>${number("overtimeMinutes", "Prolongations après (minutes)", 30, 1, 120)}</div></div><h4>Unités et bâtiments autorisés</h4><div class="unit-grid">${units.map(([value, label]) => toggle(`unit:${value}`, label, true)).join("")}</div></details>
    </div><aside class="config-preview"><img data-preview alt=""><span class="eyebrow">TA PARTIE</span><h3 data-map-name></h3><p data-summary class="muted"></p><div class="config-note">Le salon attend ton signal pour démarrer. Seuls les joueurs avec ton code peuvent rejoindre.</div><p class="error" role="alert" data-error></p><button type="submit">Créer le salon et son code</button></aside></div></form>`;
  document.body.append(d);
  const $ = (s) => d.querySelector(s);
  const input = (name) => $(`[name="${name}"]`);
  const sync = () => {
    const team = input("gameMode").value === "Team";
    $("[data-team-options]").hidden = !team;
    $("[data-nation-count]").hidden = input("nations").value !== "custom";
    $("[data-alliance-duration]").hidden =
      input("allianceMode").value !== "custom";
    $("[data-timer]").hidden = !input("maxTimer").checked;
    $("[data-doomsday]").hidden = !input("doomsday").checked;
    $("[data-overtime]").hidden = !input("overtime").checked;
    for (const wrapper of d.querySelectorAll(
      "[data-team-options], [data-nation-count], [data-alliance-duration], [data-timer], [data-doomsday], [data-overtime]",
    )) {
      for (const control of wrapper.querySelectorAll("input,select"))
        control.disabled = wrapper.hidden;
    }
    $("[data-preview]").src = selected.thumbnail;
    $("[data-preview]").alt = selected.label;
    $("[data-map-name]").textContent = selected.label;
    const nationCount =
      input("gameMapSize").value === "Compact"
        ? Math.floor(selected.nations / 4)
        : selected.nations;
    $("[data-nation-help]").textContent =
      `${selected.label} : ${nationCount} nations par défaut sur ce terrain. La difficulté s’applique aux nations.`;
    $("[data-summary]").textContent =
      `${team ? input("playerTeams").selectedOptions[0].textContent : "Chacun pour soi"} · ${input("capacity").value} places · ${input("bots").value} bots · ${input("gameMapSize").value === "Compact" ? "Carte compacte" : "Taille normale"}`;
  };
  const renderMaps = () => {
    const search = $("[data-search]")
      .value.trim()
      .toLocaleLowerCase("fr")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    const category = $("[data-category]").value;
    const shown = mapCatalog.filter(
      (map) =>
        (!category || map.categories.includes(category)) &&
        `${map.label} ${map.value}`
          .toLocaleLowerCase("fr")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .includes(search),
    );
    $("[data-map-count]").textContent =
      `${shown.length} / ${mapCatalog.length} cartes`;
    $(".config-map-grid").innerHTML = shown.length
      ? shown
          .map(
            (map) =>
              `<button type="button" class="config-map" data-map="${esc(map.value)}" aria-pressed="${selected.value === map.value}" aria-label="Carte ${esc(map.label)}"><img src="${esc(map.thumbnail)}" alt="" loading="lazy"><span>${esc(map.label)}</span></button>`,
          )
          .join("")
      : '<p class="muted">Aucune carte trouvée. Essaie un autre nom.</p>';
    for (const b of d.querySelectorAll("[data-map]"))
      b.onclick = () => {
        selected = mapCatalog.find((map) => map.value === b.dataset.map);
        input("map").value = selected.value;
        renderMaps();
        sync();
      };
  };
  $("[data-search]").oninput = renderMaps;
  $("[data-category]").onchange = renderMaps;
  for (const b of d.querySelectorAll("[data-mode]"))
    b.onclick = () => {
      input("gameMode").value = b.dataset.mode;
      for (const mode of d.querySelectorAll("[data-mode]"))
        mode.setAttribute("aria-pressed", String(mode === b));
      sync();
    };
  $("form").oninput = sync;
  $("form").onchange = sync;
  $("[data-close]").onclick = () => d.close();
  d.onclose = () => d.remove();
  $("form").onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    const numeric = (name) => Number(data.get(name));
    const checked = (name) => data.has(name);
    const settings = {
      name: data.get("name"),
      capacity: numeric("capacity"),
      map: selected.value,
      bots: numeric("bots"),
      nations:
        data.get("nations") === "custom"
          ? numeric("nationCount")
          : data.get("nations"),
      gameMode: data.get("gameMode"),
      playerTeams: /^\d+$/.test(data.get("playerTeams"))
        ? numeric("playerTeams")
        : (data.get("playerTeams") ?? 2),
      difficulty: data.get("difficulty"),
      gameMapSize: data.get("gameMapSize"),
      randomSpawn: checked("randomSpawn"),
      infiniteGold: checked("infiniteGold"),
      infiniteTroops: checked("infiniteTroops"),
      instantBuild: checked("instantBuild"),
      waterNukes: checked("waterNukes"),
      donateGold: checked("donateGold"),
      donateTroops: checked("donateTroops"),
      goldMultiplier: numeric("goldMultiplier"),
      startingGold: numeric("startingGold"),
      maxTimerValue: checked("maxTimer") ? numeric("maxTimerValue") : null,
      customAllianceDuration:
        data.get("allianceMode") === "custom"
          ? numeric("customAllianceDuration")
          : null,
      doomsdayClock: {
        enabled: checked("doomsday"),
        speed: data.get("doomsdaySpeed") ?? "normal",
      },
      overtime: {
        enabled: checked("overtime"),
        startMinutes: checked("overtime") ? numeric("overtimeMinutes") : 30,
      },
      disabledUnits: units
        .filter(([value]) => !checked(`unit:${value}`))
        .map(([value]) => value),
    };
    if (
      settings.gameMode === "Team" &&
      settings.playerTeams === "Humans Vs Nations" &&
      (settings.nations === "disabled" || selected.nations === 0)
    ) {
      $("[data-error]").textContent =
        "Active les nations et choisis une carte qui en possède pour ce mode.";
      return;
    }
    const submit = $("[type=submit]");
    submit.disabled = true;
    $("[data-error]").textContent = "";
    try {
      await create(settings);
      d.close();
      notice("Salon créé. Ton code est prêt à partager.");
      await onCreated();
    } catch (error) {
      $("[data-error]").textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  };
  renderMaps();
  sync();
  d.showModal();
}
