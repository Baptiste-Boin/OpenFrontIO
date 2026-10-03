import { GameConfig } from "../core/Schemas";
import { LangSelector } from "./LangSelector";
import { SinglePlayerModal } from "./SinglePlayerModal";

/** The admin embeds the real solo editor, with configuration as its only output.
 * This page has no game client, lobby join listener, ads or multiplayer startup.
 * The platform API remains responsible for administrator authorization.
 */
export function mountPlatformGameConfigurator(): boolean {
  const query = new URLSearchParams(window.location.search);
  const requestId = query.get("configurationRequest");
  if (
    !window.BOOTSTRAP_CONFIG?.platformApiBase ||
    window.parent === window ||
    !requestId ||
    !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)
  )
    return false;

  const language = new LangSelector();
  language.hidden = true;
  const modal = new SinglePlayerModal();
  modal.inline = true;
  modal.className = "block w-full h-full";
  document.documentElement.classList.remove("preload");
  document.body.replaceChildren(language, modal);
  document.body.style.cssText =
    "height:100vh;margin:0;overflow:hidden;background:#101923";
  modal.addEventListener("game-config-selected", (event) => {
    window.parent.postMessage(
      {
        type: "openfront-game-config",
        requestId,
        config: (event as CustomEvent<GameConfig>).detail,
      },
      window.location.origin,
    );
  });
  modal.openConfiguration();
  return true;
}
