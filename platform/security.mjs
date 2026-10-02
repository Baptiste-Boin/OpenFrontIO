import crypto from 'node:crypto';

export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export function equal(a, b) {
  return typeof a === 'string' && typeof b === 'string' && crypto.timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
}
export function cookie(req, name) {
  const item = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`));
  return item ? item.slice(name.length + 1) : '';
}
export function safeRedirect(value, origin) {
  try { const url = new URL(value || '/tournaments', origin); return url.origin === origin ? url.href : `${origin}/tournaments`; }
  catch { return `${origin}/tournaments`; }
}
export function encrypt(value, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(hash(secret),'hex'), iv);
  return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]).toString('base64url');
}
export function decrypt(value, secret) {
  const bytes = Buffer.from(value,'base64url');
  const cipher = crypto.createDecipheriv('aes-256-gcm',Buffer.from(hash(secret),'hex'),bytes.subarray(0,12));
  cipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([cipher.update(bytes.subarray(12,-16)), cipher.final()]).toString();
}
export function isBanned(user) { return user.banned && (!user.ban_until || new Date(user.ban_until).getTime() > Date.now()); }
// The winner tuple starts with [kind, label/clientId]. Team tuples carry
// winning clientIds from index 2; a player tuple includes its id at index 1.
export function winningClients(winner) {
  if (!Array.isArray(winner)) return new Set();
  return new Set(winner.slice(winner[0] === 'player' ? 1 : 2));
}
export function scrubRecord(record) {
  const copy = structuredClone(record);
  if (copy.info) {
    delete copy.info.reports;
    for (const player of copy.info.players || []) delete player.persistentID;
  }
  return copy;
}
