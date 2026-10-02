// Actual HTTP and binary-WebSocket validation against the isolated VPS project.
// Run with a bundled CodeRoomWire.integration.ts at /tmp/code-room-wire.mjs.
// Any submitted scores below are synthetic fixtures, not real tournament proof.
import { importSPKI, jwtVerify } from "jose";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import {
  createGameWireContext,
  decodeServerMessage,
  encodeClientMessage,
  UserMeResponseSchema,
} from "/tmp/code-room-wire.mjs";
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const origin = process.env.APP_URL,
  base = "http://127.0.0.1:3400";
const prefix = "CodeTest" + crypto.randomBytes(3).toString("hex");
const rooms = [],
  players = [],
  sockets = [],
  sessionHashes = [];
let checks = 0;
const eq = (a, b) => {
  assert.deepEqual(a, b);
  checks++;
};
const request = async (path, body, jar = "", withOrigin = true, extra = {}) => {
  const res = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(withOrigin ? { Origin: origin } : {}),
      ...(jar ? { Cookie: jar } : {}),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const cookies = res.headers.getSetCookie().map((v) => v.split(";")[0]);
  const map = new Map(
    jar
      .split("; ")
      .filter(Boolean)
      .map((v) => [v.split("=")[0], v]),
  );
  for (const c of cookies) {
    map.set(c.split("=")[0], c);
    if (c.startsWith("azertix_session=") && c.split("=")[1])
      sessionHashes.push(
        crypto.createHash("sha256").update(c.split("=")[1]).digest("hex"),
      );
  }
  return {
    status: res.status,
    data: res.status === 204 ? null : await res.json(),
    jar: [...map.values()].join("; "),
  };
};
const waitFor = async (predicate, timeout = 35000) => {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("WebSocket validation timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
};
const join = (room, jwt, name) => {
  const socket = new WebSocket(`ws://openfront:80/w${room.worker}`);
  sockets.push(socket);
  socket.binaryType = "arraybuffer";
  const state = {
    lobby: null,
    started: false,
    closed: null,
    ctx: undefined,
    error: null,
  };
  socket.onopen = () =>
    socket.send(
      encodeClientMessage(
        {
          type: "join",
          gameID: room.game_id,
          username: name,
          clanTag: null,
          turnstileToken: null,
          token: jwt,
          gitCommit: process.env.GIT_COMMIT,
          platform: "web",
        },
        undefined,
      ),
    );
  socket.onmessage = (event) => {
    try {
      const msg = decodeServerMessage(new Uint8Array(event.data), state.ctx);
      if (msg.type === "lobby_info") state.lobby = msg.lobby;
      if (msg.type === "start") {
        state.started = true;
        state.ctx = createGameWireContext(msg.gameStartInfo.players);
      }
    } catch (error) {
      state.error = error.message;
    }
  };
  socket.onclose = (event) => {
    state.closed = event.code;
  };
  return state;
};
try {
  eq((await request("/admin/rooms")).status, 401);
  eq(
    (
      await request("/auth/owner", {
        key: "wrong-owner-key-of-more-than-16-chars",
      })
    ).status,
    401,
  );
  eq(
    (
      await request(
        "/auth/owner",
        { key: process.env.OWNER_ACCESS_KEY },
        "",
        false,
      )
    ).status,
    403,
  );
  const owner = await request("/auth/owner", {
    key: process.env.OWNER_ACCESS_KEY,
  });
  eq(owner.status, 204);
  const me = await request("/me", undefined, owner.jar);
  eq(me.data.role, "SUPER_ADMIN");
  eq(me.data.provider, "owner");
  eq(
    (
      await request(
        `/admin/users/${me.data.publicId}/role`,
        { role: "PLAYER" },
        owner.jar,
      )
    ).status,
    409,
  );
  const settings = {
    name: prefix,
    capacity: 2,
    map: "World",
    bots: 0,
    nations: "disabled",
  };
  eq((await request("/admin/rooms", settings, owner.jar, false)).status, 403);
  for (let i = 0; i < 2; i++) {
    const made = await request("/admin/rooms", settings, owner.jar);
    eq(made.status, 201);
    rooms.push(made.data);
    assert.match(made.data.code, /^[A-Z2-9]{8}$/);
    checks++;
  }
  eq(
    (await request("/auth/code", { code: "AAAAAAAA", username: prefix }))
      .status,
    404,
  );
  eq(
    (
      await request(
        "/auth/code",
        { code: rooms[0].code, username: prefix },
        "",
        false,
      )
    ).status,
    403,
  );
  for (let i = 0; i < 2; i++) {
    const guest = await request("/auth/code", {
      code: rooms[0].code,
      username: prefix + i,
    });
    eq(guest.status, 200);
    const user = await request("/me", undefined, guest.jar);
    eq(user.data.role, "PLAYER");
    eq(user.data.provider, "guest");
    players.push({ ...guest, user: user.data });
    const refreshed = await request("/auth/refresh", {}, guest.jar);
    eq(refreshed.status, 200);
    const ticket = await request(
      "/auth/play-token",
      { gameId: rooms[0].game_id },
      guest.jar,
    );
    eq(ticket.status, 200);
    players[i].jwt = ticket.data.jwt;
    const bridge = await request("/users/@me", undefined, "", true, {
      Authorization: "Bearer " + ticket.data.jwt,
    });
    eq(bridge.status, 200);
    eq(UserMeResponseSchema.safeParse(bridge.data).success, true);
    const key = await importSPKI(
      Buffer.from(process.env.JWT_PUBLIC_KEY, "base64").toString(),
      "EdDSA",
    );
    const verified = await jwtVerify(ticket.data.jwt, key, {
      issuer: origin + "/platform-api",
      audience: new URL(origin).hostname,
    });
    eq(verified.payload.provider, "code:" + rooms[0].game_id);
  }
  eq(
    (
      await request("/auth/code", {
        code: rooms[0].code,
        username: prefix + "full",
      })
    ).status,
    409,
  );
  eq((await request("/admin/rooms", settings, players[0].jar)).status, 403);
  eq(
    (
      await request(
        `/admin/users/${players[0].user.publicId}/role`,
        { role: "SUPER_ADMIN" },
        owner.jar,
      )
    ).status,
    403,
  );
  eq(
    (
      await request(
        "/auth/play-token",
        { gameId: rooms[1].game_id },
        players[0].jar,
      )
    ).status,
    403,
  );
  const rejected = join(rooms[1], players[0].jwt, prefix + "wrong");
  await waitFor(() => rejected.closed !== null, 12000);
  assert.notEqual(rejected.closed, 1000);
  checks++;
  const first = join(rooms[0], players[0].jwt, prefix + "0"),
    second = join(rooms[0], players[1].jwt, prefix + "1");
  await waitFor(
    () =>
      first.lobby?.clients.length === 2 && second.lobby?.clients.length === 2,
    15000,
  );
  eq(
    (await request(`/admin/rooms/${rooms[0].id}/players`, undefined, owner.jar))
      .data.players.length,
    2,
  );
  eq(
    (
      await request(
        `/admin/rooms/${rooms[0].id}/action`,
        { action: "start" },
        owner.jar,
      )
    ).status,
    204,
  );
  await waitFor(() => first.started && second.started);
  checks++;
  eq(
    (
      await request(
        `/admin/rooms/${rooms[0].id}/action`,
        { action: "pause" },
        owner.jar,
      )
    ).status,
    204,
  );
  eq(
    (
      await request(
        `/admin/rooms/${rooms[0].id}/action`,
        { action: "resume" },
        owner.jar,
      )
    ).status,
    204,
  );
  const userIds = (
    await db.query("SELECT id FROM users WHERE public_id=ANY($1::uuid[])", [
      players.map((p) => p.user.publicId),
    ])
  ).rows.map((r) => r.id);
  const record = {
    info: {
      gameID: rooms[0].game_id,
      players: userIds.map((id, i) => ({
        clientID: i ? "Bcde2345" : "Abcd1234",
        persistentID: id,
      })),
      winner: ["player", "Abcd1234"],
    },
    version: "v0.0.2",
    turns: [],
  };
  eq((await request(`/game/${rooms[0].game_id}`, record)).status, 401);
  for (let i = 0; i < 2; i++)
    eq(
      (
        await request(`/game/${rooms[0].game_id}`, record, "", true, {
          "x-api-key": process.env.API_KEY,
        })
      ).status,
      204,
    );
  const score = (
    await db.query(
      "SELECT count(*)::int n,sum(points)::int points FROM results WHERE game_id=$1",
      [rooms[0].game_id],
    )
  ).rows[0];
  eq(score, { n: 2, points: 11 });
  eq(
    (await request("/me/history", undefined, players[0].jar)).data[0].name,
    prefix,
  );
  eq(
    (
      await request(
        "/auth/play-token",
        { gameId: rooms[0].game_id },
        players[0].jar,
      )
    ).status,
    404,
  );
  eq(
    (await request("/auth/code", { code: rooms[0].code, username: prefix }))
      .status,
    404,
  );
  eq(
    (
      await request(
        `/admin/rooms/${rooms[1].id}/action`,
        { action: "cancel" },
        owner.jar,
      )
    ).status,
    204,
  );
  eq(
    (await request("/auth/code", { code: rooms[1].code, username: prefix }))
      .status,
    404,
  );
  console.log(
    `${checks} HTTP, owner, code-room, binary-WebSocket and synthetic-score checks passed.`,
  );
} finally {
  for (const socket of sockets) socket.close();
  for (const room of rooms) {
    await fetch(
      `http://openfront:80/w${room.worker}/api/adminbot/game/${room.game_id}/cancel`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-bot-key": process.env.ADMIN_BOT_API_KEY,
        },
        body: "{}",
      },
    ).catch(() => {});
    await db.query("DELETE FROM results WHERE game_id=$1", [room.game_id]);
    await db.query("DELETE FROM archives WHERE game_id=$1", [room.game_id]);
    await db.query("DELETE FROM room_players WHERE room_id=$1", [room.id]);
    await db.query("DELETE FROM audit_logs WHERE target=$1", [room.id]);
    await db.query("DELETE FROM rooms WHERE id=$1", [room.id]);
  }
  await db.query("DELETE FROM sessions WHERE token_hash=ANY($1::text[])", [
    sessionHashes,
  ]);
  await db.query(
    "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username LIKE $1)",
    [prefix + "%"],
  );
  await db.query("DELETE FROM users WHERE username LIKE $1", [prefix + "%"]);
  await db.end();
}
