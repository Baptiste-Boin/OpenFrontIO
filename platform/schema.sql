CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY, public_id uuid UNIQUE NOT NULL, discord_id text UNIQUE NOT NULL,
 username text NOT NULL, avatar text, discord_data jsonb NOT NULL DEFAULT '{}',
 role text NOT NULL DEFAULT 'PLAYER' CHECK(role IN ('PLAYER','MODERATOR','TOURNAMENT_ADMIN','SUPER_ADMIN')),
 guild_checked_at timestamptz, guild_token text,
 banned boolean NOT NULL DEFAULT false, ban_until timestamptz, ban_reason text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS tournaments (
 id uuid PRIMARY KEY, name text NOT NULL, starts_at timestamptz NOT NULL,
 capacity integer NOT NULL CHECK(capacity BETWEEN 2 AND 200), rounds integer NOT NULL CHECK(rounds BETWEEN 1 AND 20),
 rules text NOT NULL DEFAULT '', game_config jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','open','closed','running','finished')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS participants (
 tournament_id uuid REFERENCES tournaments(id), user_id uuid REFERENCES users(id),
 registered_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tournament_id,user_id)
);
CREATE TABLE IF NOT EXISTS matches (
 id uuid PRIMARY KEY, tournament_id uuid NOT NULL REFERENCES tournaments(id), round integer NOT NULL,
 game_id text UNIQUE NOT NULL, worker integer NOT NULL, status text NOT NULL DEFAULT 'lobby',
 config jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tournament_id,round)
);
CREATE TABLE IF NOT EXISTS archives (
 game_id text PRIMARY KEY, record jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS results (
 game_id text REFERENCES archives(game_id), tournament_id uuid REFERENCES tournaments(id),
 user_id uuid REFERENCES users(id), winner boolean NOT NULL, points integer NOT NULL,
 PRIMARY KEY(game_id,user_id)
);
CREATE TABLE IF NOT EXISTS audit_logs (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor uuid REFERENCES users(id),
 action text NOT NULL, target text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS announcements (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, content text NOT NULL,
 delivered_at timestamptz, attempts integer NOT NULL DEFAULT 0, next_attempt timestamptz NOT NULL DEFAULT now()
);
