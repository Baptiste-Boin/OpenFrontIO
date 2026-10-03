import type { TokenPayload } from "../core/ApiSchemas";

// Called only after signature, issuer, audience and expiry verification.
export function platformJoinAllowed(
  claims: TokenPayload | null,
  gameId: string,
  tournamentAllowlist: boolean,
): boolean {
  if (!claims || claims.role === "banned") return false;
  if (["root", "admin", "mod"].includes(claims.role ?? ""))
    return claims.provider === "owner" || claims.provider === "discord";
  if (claims.provider === `code:${gameId}`) return true;
  return claims.provider === "discord" && tournamentAllowlist;
}
