// Emergency reset if the finance admin is locked out: npm run reset-password firstname.lastname
import { resolve } from 'node:path';
import { initDb, one, run } from '../src/db.js';
import { hashPassword, tempPassword } from '../src/auth.js';

initDb(resolve(import.meta.dirname, '..', process.env.COMB_DB ?? 'data/comb.db'));
const u = one('SELECT * FROM users WHERE username = ?', process.argv[2] ?? '');
if (!u) { console.error('No such user.'); process.exit(1); }
const pw = tempPassword();
run('UPDATE users SET pass_hash = ?, must_change = 1 WHERE id = ?', hashPassword(pw), u.id);
console.log(`Temporary password for ${u.name}: ${pw}`);
