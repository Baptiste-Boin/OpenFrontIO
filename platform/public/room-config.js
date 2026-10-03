// The native game's SinglePlayerModal renders the editor. This shell only
// collects organizer metadata and hands its result to the protected API.
export async function openRoomConfigurator({
  kind = "room",
  create,
  onCreated,
  notice,
}) {
  const tournament = kind === "tournament";
  const requestId = crypto.randomUUID();
  const dialog = document.createElement("dialog");
  dialog.className = "native-configurator";
  dialog.setAttribute("aria-labelledby", "config-title");
  dialog.innerHTML = `<header class="config-header"><div><span class="eyebrow">${tournament ? "TOURNOI" : "SALON PRIVÉ"}</span><h2 id="config-title">${tournament ? "Créer un tournoi" : "Préparer la partie"}</h2><p class="muted">${tournament ? "Ces réglages seront utilisés pour chaque manche." : "Configure le jeu, puis partage le code avec tes joueurs."}</p></div><button type="button" class="secondary small" data-close>Fermer</button></header>
    <form class="config-metadata"><div class="fields"><label>${tournament ? "Nom du tournoi" : "Nom du salon"}<input name="name" required minlength="${tournament ? 3 : 2}" maxlength="${tournament ? 120 : 80}" placeholder="Partie de la communauté"></label><label>Places pour les joueurs<input name="capacity" type="number" value="${tournament ? 32 : 20}" min="2" max="200" required></label>${tournament ? '<label>Date et heure de Paris<input name="startsAt" type="datetime-local" required></label><label>Manches<input name="rounds" type="number" value="3" min="1" max="20" required></label>' : ""}</div>${tournament ? '<label>Règles du tournoi<textarea name="rules" maxlength="5000" rows="2"></textarea></label>' : ""}<p class="muted" data-progress>Chargement du configurateur du jeu…</p><p role="alert" data-error></p></form>
    <iframe title="Configuration native du jeu" src="/?configurationRequest=${requestId}"></iframe>`;
  const form = dialog.querySelector("form");
  const frame = dialog.querySelector("iframe");
  const progress = dialog.querySelector("[data-progress]");
  const error = dialog.querySelector("[data-error]");
  let saving = false;
  frame.addEventListener("load", () => {
    progress.textContent =
      "Choisis la carte et les options, puis clique sur « Utiliser ces réglages ».";
  });
  const receive = async (event) => {
    if (
      event.origin !== location.origin ||
      event.source !== frame.contentWindow ||
      event.data?.type !== "openfront-game-config" ||
      event.data.requestId !== requestId ||
      saving ||
      !dialog.open
    )
      return;
    if (!form.reportValidity()) return;
    const config = event.data.config;
    if (!config || typeof config !== "object" || Array.isArray(config)) return;
    const data = new FormData(form);
    const metadata = {
      name: data.get("name"),
      capacity: Number(data.get("capacity")),
    };
    saving = true;
    error.textContent = "";
    progress.textContent = "Création en cours…";
    frame.style.pointerEvents = "none";
    frame.setAttribute("inert", "");
    try {
      const settings = { ...config };
      delete settings.gameMap;
      delete settings.gameType;
      await create(
        tournament
          ? {
              ...metadata,
              startsAt: data.get("startsAt"),
              rounds: Number(data.get("rounds")),
              rules: data.get("rules"),
              gameConfig: config,
            }
          : { ...settings, ...metadata, map: config.gameMap },
      );
      dialog.close();
      notice(
        tournament
          ? "Tournoi créé avec tes réglages"
          : "Salon créé : partage son code pour jouer",
      );
      await onCreated();
    } catch (e) {
      error.textContent = e.message;
      progress.textContent = "Corrige les réglages et réessaie.";
    } finally {
      saving = false;
      frame.style.pointerEvents = "";
      frame.removeAttribute("inert");
    }
  };
  window.addEventListener("message", receive);
  form.addEventListener("submit", (event) => event.preventDefault());
  dialog.querySelector("[data-close]").onclick = () => dialog.close();
  dialog.addEventListener(
    "close",
    () => {
      window.removeEventListener("message", receive);
      dialog.remove();
    },
    { once: true },
  );
  document.body.append(dialog);
  dialog.showModal();
  form.elements.name.focus();
}
