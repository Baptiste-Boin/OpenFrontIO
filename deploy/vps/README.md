# AzertixYT OpenFront sur le VPS Tralo

La plateforme se déploie depuis `Baptiste-Boin/OpenFrontIO`. Le moteur original
reste intact. La couche `platform/` fournit Discord OAuth, rôles, inscriptions,
manches, résultats automatiques, classement, audit et bot Discord optionnel.

## Isolation

- Projet Compose `openfront`, réseaux `openfront_edge`, `openfront_game`,
  `openfront_data`, volumes PostgreSQL et Redis propres à OpenFront.
- Aucun réseau, compte SQL, volume ni secret Tralo partagé.
- `CDN_BASE` reprend `APP_URL` : les cartes restent sur le VPS. Une base
  absolue est nécessaire aux workers Blob du moteur, qui ne peuvent pas
  résoudre les chemins relatifs depuis leur URL Blob.
- Ports hôte uniquement `127.0.0.1:3300` (jeu) et `127.0.0.1:3400` (plateforme).
- Le Caddy existant conserve les ports 80/443. Importer `openfront.caddy` après
  validation ; ne pas démarrer un deuxième Caddy.
- PostgreSQL et Redis n’ont aucun port publié. Les routes admin du jeu et
  d’écriture des résultats sont bloquées par Caddy et exigent une clé interne.
- Mémoire totale plafonnée à environ 1,4 Gio. Mesurer un vrai tournoi avant
  d’augmenter le nombre de joueurs ou de workers ; un worker est configuré ici.

## Première installation

1. Créer `/srv/openfront` appartenant à root. Exécuter une seule fois
   `sudo node deploy/vps/generate-env.mjs https://openfront.azertixyt.fr`.
   Le générateur refuse d’écraser un fichier existant et ne publie aucun secret.
2. Configurer l’enregistrement DNS A vers le VPS. Ajouter le bloc Caddy,
   sauvegarder le Caddyfile, valider puis recharger Caddy.
3. Exécuter `sudo bash deploy/vps/deploy.sh <SHA_GITHUB_COMPLET>`.
   Le script clone GitHub et crée `/srv/openfront/releases/<sha>` ; le build et
   le démarrage utilisent ce commit, jamais une copie locale envoyée par SCP.
4. Après le premier succès, installer les quatre unités `openfront-*.service`
   et `openfront-*.timer` dans `/etc/systemd/system`, recharger systemd et
   activer les timers update et backup.

Les mises à jour automatiques lisent **main** toutes les 30 minutes. Elles
attendent que la PR déployée soit fusionnée avant de remplacer cette version.
Après succès, seuls les worktrees et images OpenFront de la version active et
de la précédente sont conservés. Aucun volume, dump ou artefact Tralo n’est
supprimé ; les sources supprimées restent récupérables depuis GitHub.
Aucune PR n’est fusionnée par le VPS. Le déploiement refuse une évolution de
main qui ne descend pas de la version active. Un SHA explicite permet un
retour arrière. Les migrations présentes sont additives ; un futur changement
SQL destructif doit avoir une procédure dédiée, pas être ajouté au démarrage.

## Salons privés et accès propriétaire

Les joueurs utilisent un pseudo et le code à huit caractères partagé par
l’organisateur. Discord est facultatif pour ce parcours. Le propriétaire
crée les salons dans `/admin`, copie leur code ou leur lien, consulte le roster,
démarre la partie, met en pause/reprend et ferme le salon. Seuls les comptes
administrateurs peuvent créer des salons. Un invité ne peut pas recevoir un
rôle administrateur. Chaque ticket signé de joueur est lié à un seul game ID,
y compris les reconnexions ; le code expire quand la partie est fermée ou terminée.

Activer l’accès propriétaire avant le déploiement :

```sh
sudo bash deploy/vps/owner-access.sh
```

La clé aléatoire est créée une seule fois dans
`/srv/openfront/owner-access.key` (root, 0600), sans affichage dans les logs.
Le conteneur ne reçoit que son hash SHA-256 via `OWNER_ACCESS_HASH`.
Le propriétaire récupère cette clé dans son terminal SSH et la saisit dans
`/admin` → Connexion organisateur. Les sessions propriétaire expirent après
12 heures. La clé ne doit pas être partagée avec les joueurs ni ajoutée à Git.
Le script refuse de remplacer une clé déjà configurée.

Les salons vivent dans la mémoire du moteur ; un redémarrage du moteur ferme
leurs anciens codes. Les profils, historiques et résultats restent en SQL.
Les tournois Discord et leurs listes de participants sont conservés.

## Discord facultatif

Modifier uniquement `/srv/openfront/.env` (root, 0600) :

- `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_GUILD_ID`.
- `ADMIN_DISCORD_IDS` : IDs Discord de secours, séparés par des virgules.
- `DISCORD_BOT_TOKEN`, `DISCORD_ANNOUNCEMENT_CHANNEL_ID` pour le bot.

Déclarer dans Discord le callback exact :
`https://openfront.azertixyt.fr/platform-api/auth/discord/callback`.
Scopes OAuth de connexion : `identify guilds.members.read`.
Inviter le bot avec `bot applications.commands`, autoriser l’envoi de messages
uniquement dans le salon choisi. Les commandes admin sont masquées par défaut
(permissions Discord à attribuer) et revérifient le rôle PostgreSQL.

Après une modification des variables, relancer uniquement les services
OpenFront avec le SHA actif :

```sh
sudo bash -c 'export RELEASE_SHA=$(cat /srv/openfront/current-sha); docker compose --env-file /srv/openfront/.env --file /srv/openfront/current/deploy/vps/compose.yml up -d --wait'
```

Sans identifiants Discord, le jeu solo et les pages publiques fonctionnent.
Le jeu multijoueur et l’administration exigent Discord. Aucun administrateur
par défaut ni accès anonyme à `/admin`. L’état OAuth est à usage unique,
lié à un cookie, et expire dans Redis ; les sessions sont hachées en SQL.
Les tokens Discord sont chiffrés avec AES-GCM, jamais renvoyés au navigateur.
Les JWT du jeu sont Ed25519, audience et issuer locaux, durée de cinq minutes.
La vérification d’appartenance Discord est renouvelée aux inscriptions et au
renouvellement du token de jeu. Si le token Discord expire, se reconnecter.

## Tournois et résultats

Créer un tournoi, ouvrir/fermer les inscriptions, démarrer le tournoi puis
créer sa manche. La liste des participants autorisés est figée à la création
du lobby. Les bans empêchent les sessions et les prochaines entrées ; utiliser
l’exclusion du lobby pour expulser immédiatement un joueur déjà connecté.

Les résultats proviennent du vote de fin de partie du moteur OpenFront,
transmis par le serveur sous clé. Ils ne représentent pas une simulation
anti-triche côté serveur. Une victoire = 10 points, une participation = 1 ;
une partie annulée n’attribue aucun point. Les envois en double ne comptent
jamais deux fois. Aucun classement top 3 n’est inventé lorsque le moteur ne
fournit qu’un vainqueur. Les archives publiques masquent les identités privées
et les signalements. Aucun achat de la boutique officielle n’est implémenté.

Le bot propose `/tournoi`, `/classement`, `/profil`, `/inscription`,
`/prochaine-partie`, `/tournament`, `/match`, `/player`. Ses annonces utilisent
une file SQL et désactivent les mentions Discord ; les échecs sont réessayés.
Le panneau Live mesure les joueurs de partie, les connexions WebSocket, les
parties et la charge du VPS via une route interne protégée. Les menus du jeu
renvoient vers cette plateforme ; les scripts publicitaires et analytiques
d’OpenFront officiel ne sont pas chargés dans ce mode.

SMTP n’est pas nécessaire pour cette authentification exclusivement Discord.

## Sauvegarde et retour arrière

`backup.sh` produit un dump SQL compressé chaque nuit à 02:45 Paris et garde
14 jours de dumps. Ces sauvegardes sont **sur le même VPS** : configurer une
copie hors VPS séparément. Vérifier un dump avec `gzip -t` et une restauration
vers une base isolée avant tout usage pour reprise après sinistre.

Pour revenir au commit précédent :
`sudo bash /srv/openfront/current/deploy/vps/deploy.sh $(sudo cat /srv/openfront/previous-sha)`.
Les volumes sont conservés ; ne jamais utiliser `docker compose down -v`.
Un échec du contrôle de santé restaure les conteneurs précédents, mais ne
réverse pas une migration SQL (les migrations de cette version sont additives).

Contrôles : `/platform-api/health`, `/api/health`, conteneurs healthy, classement
et sauvegarde. Une validation solo ne prouve pas un tournoi réel à plusieurs
joueurs, une connexion Discord réelle ou l’envoi de commandes par le bot.

### Création des parties et tournois

Sur le site avec `PLATFORM_API_BASE`, les joueurs rejoignent une partie avec un code. Les parties solo et le tutoriel jouable sont désactivés, y compris les lancements directs du composant et de la route de modal. Le mode solo reste disponible dans une installation OpenFront classique sans plateforme.

Dans Administration → Salons ou Tournois, la création embarque le véritable `SinglePlayerModal` et ses composants `GameConfigSettings` / `MapPicker`. Le bouton « Utiliser ces réglages » émet une configuration privée ; cette vue ne crée jamais de partie solo. Carte, équipes (2 à 8, duos, trios, quatuors, humains contre nations), bots, nations et options avancées sont transmis au serveur. Les tournois réutilisent ces réglages pour chaque manche.

Le message du configurateur est lié à son iframe, à l’origine du site et à un identifiant de création. Les API gardent leurs contrôles de session administrateur, de CSRF et une liste stricte de réglages autorisés. Capacité, visibilité privée et accès des inscrits restent imposés côté serveur.
