// Run inside the platform container against the isolated OpenFront database.
// Uses disposable SQL fixtures: this does not validate real Discord OAuth.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const origin = process.env.APP_URL;
const prefix = "vps-test-" + crypto.randomUUID();
const users = [],
  sessions = [];
let tournament, match;
const request = async (path, body, session, withOrigin = true, extra = {}) => {
  const response = await fetch("http://127.0.0.1:3400" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(withOrigin ? { Origin: origin } : {}),
      ...(session ? { Cookie: "azertix_session=" + session } : {}),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = response.status === 204 ? null : await response.json();
  return { status: response.status, data };
};
async function fixture(role) {
  const id = crypto.randomUUID(),
    publicId = crypto.randomUUID(),
    token = crypto.randomBytes(48).toString("base64url");
  users.push(id);
  sessions.push(token);
  await db.query(
    "INSERT INTO users(id,public_id,discord_id,username,role) VALUES($1,$2,$3,$4,$5)",
    [id, publicId, prefix + "-" + id, prefix, role],
  );
  await db.query(
    "INSERT INTO sessions VALUES($1,$2,now()+interval '10 minutes')",
    [crypto.createHash("sha256").update(token).digest("hex"), id],
  );
  return { id, publicId, token };
}
try {
  const admin = await fixture("SUPER_ADMIN"),
    player = await fixture("PLAYER"),
    player2 = await fixture("PLAYER");
  assert.equal((await request("/admin/live")).status, 401);
  const live = await request("/admin/live", undefined, admin.token);
  assert.equal(live.status, 200);
  assert.equal(typeof live.data.connections.webSockets, "number");
  assert.ok(live.data.host.memoryTotalBytes > 0);
  assert.equal(
    (await request("/admin/tournaments", {}, player.token)).status,
    403,
  );
  const payload = {
    name: prefix,
    startsAt: new Date(Date.now() + 3600000).toISOString(),
    capacity: 2,
    rounds: 1,
    rules: "Synthetic VPS validation",
    gameConfig: {
      gameMap: "World",
      gameMode: "Free For All",
      bots: 0,
      nations: "disabled",
    },
  };
  assert.equal(
    (await request("/admin/tournaments", payload, admin.token, false)).status,
    403,
  );
  const created = await request("/admin/tournaments", payload, admin.token);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  tournament = created.data.id;
  assert.equal(
    (await request(`/admin/tournaments/${tournament}/matches`, {}, admin.token))
      .status,
    409,
  );
  for (const status of ["open", "closed", "running"])
    assert.equal(
      (
        await request(
          `/admin/tournaments/${tournament}/status`,
          { status },
          admin.token,
        )
      ).status,
      204,
    );
  await db.query(
    "INSERT INTO participants(tournament_id,user_id) VALUES($1,$2),($1,$3)",
    [tournament, player.id, player2.id],
  );
  const lobby = await request(
    `/admin/tournaments/${tournament}/matches`,
    {},
    admin.token,
  );
  assert.equal(lobby.status, 201, JSON.stringify(lobby.data));
  match = lobby.data;
  assert.equal(
    (await request(`/admin/tournaments/${tournament}/matches`, {}, admin.token))
      .status,
    409,
  );
  const roster = await request(
    `/admin/matches/${match.id}/roster`,
    undefined,
    admin.token,
  );
  assert.equal(roster.status, 200);
  assert.deepEqual(roster.data.players, []);
  assert.equal(
    (
      await request(
        `/admin/matches/${match.id}/action`,
        { action: "pause" },
        admin.token,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await request(
        `/admin/matches/${match.id}/action`,
        { action: "cancel" },
        admin.token,
      )
    ).status,
    204,
  );
  const oldGameId = match.gameId;
  const restarted = await request(
    `/admin/matches/${match.id}/restart`,
    {},
    admin.token,
  );
  assert.equal(restarted.status, 201);
  assert.notEqual(restarted.data.gameId, match.gameId);
  match = restarted.data;
  await db.query("DELETE FROM archives WHERE game_id=$1", [oldGameId]);
  assert.equal(
    (await request(`/admin/matches/${match.id}/restart`, {}, admin.token))
      .status,
    409,
  );
  assert.equal(
    (
      await request(
        `/admin/matches/${match.id}/action`,
        { action: "cancel" },
        admin.token,
      )
    ).status,
    204,
  );
  // A second test match reuses the tournament only to test scoring receipt.
  await db.query("UPDATE matches SET status='running' WHERE id=$1", [match.id]);
  const record = {
    info: {
      gameID: match.gameId,
      players: [
        { clientID: "Abcd1234", persistentID: player.id },
        { clientID: "Bcde2345", persistentID: player2.id },
      ],
      winner: ["player", "Abcd1234"],
      reports: [{ reporter: player.id }],
    },
    version: "v0.0.2",
    turns: [],
  };
  assert.equal((await request(`/game/${match.gameId}`, record)).status, 401);
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await request(`/game/${match.gameId}`, record, undefined, true, {
          "x-api-key": process.env.API_KEY,
        })
      ).status,
      204,
    );
  const results = (
    await db.query(
      "SELECT count(*)::int count,sum(points)::int points,count(*) FILTER(WHERE winner)::int wins FROM results WHERE game_id=$1",
      [match.gameId],
    )
  ).rows[0];
  assert.deepEqual(results, { count: 2, points: 11, wins: 1 });
  const history = await request("/me/history", undefined, player.token);
  assert.equal(history.status, 200);
  assert.equal(history.data[0].points, 10);
  assert.equal(
    (
      await request(
        `/admin/users/${player.publicId}/history`,
        undefined,
        admin.token,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        `/admin/users/${player.publicId}/history`,
        undefined,
        player.token,
      )
    ).status,
    403,
  );
  const archive = await request(`/game/${match.gameId}`);
  assert.equal(archive.status, 200);
  assert.equal(archive.data.info.players[0].persistentID, undefined);
  assert.equal(archive.data.info.reports, undefined);
  assert.equal(
    (
      await request(
        `/admin/users/${admin.publicId}/ban`,
        { banned: true },
        admin.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        `/admin/users/${player.publicId}/ban`,
        { banned: true, reason: "Synthetic test", until: null },
        admin.token,
      )
    ).status,
    204,
  );
  assert.equal((await request("/me", undefined, player.token)).status, 401);
  assert.equal(
    (
      await request(
        `/admin/tournaments/${tournament}/status`,
        { status: "finished" },
        admin.token,
      )
    ).status,
    204,
  );
  console.log(
    JSON.stringify({
      status: "passed",
      checks: 25,
      covered: [
        "session authentication",
        "roles",
        "CSRF",
        "tournament transitions",
        "actual game lobby creation and roster",
        "cancel",
        "duplicate result protection",
        "points",
        "archive privacy",
        "ban revocation",
      ],
      discordOAuth: "not tested; synthetic SQL fixtures",
    }),
  );
} finally {
  if (tournament) {
    await db.query("DELETE FROM results WHERE tournament_id=$1", [tournament]);
    await db.query(
      "DELETE FROM announcements WHERE content LIKE $1 OR content LIKE $2",
      ["%" + prefix + "%", "%" + tournament + "%"],
    );
    if (match)
      await db.query("DELETE FROM archives WHERE game_id=$1", [match.gameId]);
    await db.query("DELETE FROM matches WHERE tournament_id=$1", [tournament]);
    await db.query("DELETE FROM participants WHERE tournament_id=$1", [
      tournament,
    ]);
    await db.query("DELETE FROM tournaments WHERE id=$1", [tournament]);
  }
  await db.query(
    "DELETE FROM audit_logs WHERE actor=ANY($1::uuid[]) OR target=$2",
    [users, match?.gameId ?? null],
  );
  await db.query("DELETE FROM sessions WHERE user_id=ANY($1::uuid[])", [users]);
  await db.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [users]);
  await db.end();
}
