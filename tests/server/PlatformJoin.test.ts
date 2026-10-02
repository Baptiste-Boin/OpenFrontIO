// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { TokenPayload } from "../../src/core/ApiSchemas";
import { platformJoinAllowed } from "../../src/server/PlatformJoin";
const claims = (provider: string, role = "player") =>
  ({ provider, role }) as TokenPayload;
describe("signed code-room access", () => {
  it("binds a guest ticket to exactly one game, including reconnects", () => {
    expect(
      platformJoinAllowed(claims("code:a123456789"), "a123456789", false),
    ).toBe(true);
    expect(
      platformJoinAllowed(claims("code:a123456789"), "a987654321", false),
    ).toBe(false);
    expect(platformJoinAllowed(claims("guest"), "a123456789", false)).toBe(
      false,
    );
    expect(platformJoinAllowed(null, "a123456789", false)).toBe(false);
  });
  it("does not let a Discord identity bypass the code of a standalone room", () => {
    expect(platformJoinAllowed(claims("discord"), "a123456789", false)).toBe(
      false,
    );
    expect(platformJoinAllowed(claims("discord"), "a123456789", true)).toBe(
      true,
    );
  });
  it("accepts the owner but refuses guest privilege escalation and banned tickets", () => {
    expect(
      platformJoinAllowed(claims("owner", "root"), "a123456789", false),
    ).toBe(true);
    expect(
      platformJoinAllowed(
        claims("code:a123456789", "root"),
        "a123456789",
        false,
      ),
    ).toBe(false);
    expect(
      platformJoinAllowed(
        claims("code:a123456789", "banned"),
        "a123456789",
        false,
      ),
    ).toBe(false);
  });
});
