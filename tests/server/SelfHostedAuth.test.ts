// @vitest-environment node
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerEnv } from "../../src/server/ServerEnv";
import { verifyClientToken } from "../../src/server/jwt";

describe("self-hosted Discord token trust boundary", () => {
  const issuer = "https://openfront.example.test/platform-api";
  beforeEach(() => {
    vi.stubEnv("JWT_ISSUER", issuer);
    vi.stubEnv("API_INTERNAL_URL", "http://platform:3400");
    vi.stubEnv("DOMAIN", "openfront.example.test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  it("keeps the public token issuer distinct from internal HTTP transport", () => {
    expect(ServerEnv.jwtIssuer()).toBe(issuer);
    expect(ServerEnv.apiBaseUrl()).toBe("http://platform:3400");
  });
  it("validates Ed25519 Discord tokens and refuses foreign issuers, audiences and unsigned identities", async () => {
    const { publicKey, privateKey } = await generateKeyPair("EdDSA");
    vi.spyOn(ServerEnv, "jwkPublicKey").mockResolvedValue(
      await exportJWK(publicKey),
    );
    const sub = Buffer.from("123456781234423482341234567890ab", "hex").toString(
      "base64url",
    );
    const sign = (iss = issuer, aud = "openfront.example.test") =>
      new SignJWT({ provider: "discord", role: "player" })
        .setProtectedHeader({ alg: "EdDSA" })
        .setSubject(sub)
        .setJti("test")
        .setIssuer(iss)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
    const valid = await verifyClientToken(await sign());
    expect(valid.type).toBe("success");
    if (valid.type === "success")
      expect(valid.persistentId).toBe("12345678-1234-4234-8234-1234567890ab");
    expect(
      (await verifyClientToken(await sign("https://evil.test"))).type,
    ).toBe("error");
    expect(
      (await verifyClientToken(await sign(issuer, "another.example.test")))
        .type,
    ).toBe("error");
    expect((await verifyClientToken("not-a-token")).type).toBe("error");
  });
});
