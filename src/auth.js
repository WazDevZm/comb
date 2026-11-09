import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { one, run } from './db.js';

const SESSION_DAYS = 7;
export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pw, salt, 64).toString('hex')}`;
}
export function checkPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  return timingSafeEqual(scryptSync(pw, Buffer.from(salt, 'hex'), 64), Buffer.from(hash, 'hex'));
}
export const tempPassword = () => randomBytes(6).toString('base64url');
const sha = (t) => createHash('sha256').update(t).digest('hex');

export function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha(token), userId, expires);
  return token;
}
export function userFromToken(token) {
  if (!token) return null;
  return one(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`, sha(token), new Date().toISOString()) ?? null;
}
export const destroySession = (token) => token && run('DELETE FROM sessions WHERE token_hash = ?', sha(token));

const attempts = new Map();
export function tooManyAttempts(key) {
  const a = attempts.get(key);
  return !!a && a.count >= 8 && Date.now() - a.first < 15 * 60e3;
}
export function noteFailure(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > 15 * 60e3) attempts.set(key, { count: 1, first: Date.now() });
  else a.count++;
}
export const clearFailures = (key) => attempts.delete(key);
