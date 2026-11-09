import { resolve } from 'node:path';
import { initDb } from './db.js';
import { seedReference, seedDemo } from './seed.js';
import { createApp } from './app.js';
import { aiEnabled } from './ai.js';

const root = resolve(import.meta.dirname, '..');
const demo = process.env.COMB_DEMO === '1';
const dbFile = resolve(root, process.env.COMB_DB ?? 'data/comb.db');
const uploadDir = resolve(root, process.env.COMB_UPLOADS ?? (demo ? 'data/demo-uploads' : 'data/uploads'));
const port = Number(process.env.PORT ?? 4300);

initDb(dbFile);
const first = seedReference();
if (demo) seedDemo();

const app = createApp({ uploadDir, demo });
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.listen(port, process.env.HOST ?? '127.0.0.1', () => {
  console.log(`Comb is running at http://localhost:${port}${demo ? ' (demo data)' : ''}`);
  console.log(`AI document reading: ${aiEnabled() ? 'on' : 'off (set ANTHROPIC_API_KEY to switch it on)'}`);
  if (first && !demo) console.log(`\nFirst sign-in: ${first.username} / ${first.password}\nThis is shown once. You will be asked to change it.\n`);
});
