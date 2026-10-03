import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decrypt,
  encrypt,
  equal,
  isBanned,
  safeRedirect,
  scrubRecord,
  winningClients,
} from "../security.mjs";
test("OAuth return URL stays on the platform origin", () => {
  const origin = "https://openfront.azertixyt.fr";
  for (const value of [
    "https://evil.test",
    "//evil.test",
    "javascript:alert(1)",
  ])
    assert.equal(safeRedirect(value, origin), origin + "/tournaments");
  assert.equal(safeRedirect("/profile", origin), origin + "/profile");
});
test("Discord access token encryption rejects tampering and wrong secret", () => {
  const secret = "a".repeat(64),
    token = encrypt("discord-token", secret);
  assert.equal(decrypt(token, secret), "discord-token");
  assert.throws(() => decrypt(token, "b".repeat(64)));
  const bytes = Buffer.from(token, "base64url");
  bytes[14] ^= 1;
  assert.throws(() => decrypt(bytes.toString("base64url"), secret));
});
test("temporary bans expire, permanent bans do not", () => {
  assert.equal(isBanned({ banned: true }), true);
  assert.equal(isBanned({ banned: true, ban_until: "2000-01-01" }), false);
  assert.equal(isBanned({ banned: false }), false);
});
test("winning team label is never interpreted as a player", () => {
  assert.deepEqual(
    [...winningClients(["team", "Red", "p1", "p2"])],
    ["p1", "p2"],
  );
  assert.deepEqual([...winningClients(["player", "p1"])], ["p1"]);
  assert.equal(winningClients(undefined).size, 0);
});
test("public replay removes account identifiers and reports without mutating scoring input", () => {
  const record = {
    info: {
      players: [{ clientID: "p1", persistentID: "secret" }],
      reports: [{ reporter: "secret" }],
    },
  };
  const publicRecord = scrubRecord(record);
  assert.equal(publicRecord.info.players[0].persistentID, undefined);
  assert.equal(publicRecord.info.reports, undefined);
  assert.equal(record.info.players[0].persistentID, "secret");
  assert.equal(equal(undefined, "x"), false);
  assert.equal(equal("x", "x"), true);
});
