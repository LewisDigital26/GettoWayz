// Copies the website (repo root) into apps/www so the Android and iOS apps are built from
// exactly the same code as the live site. Run before every `npx cap sync`.
// Never edit apps/www by hand — it is wiped and rebuilt each time.
import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');       // repo root = the website
const out = join(here, '..', 'www');       // what Capacitor packs into the apps

// Everything the site needs at runtime. Anything not listed (apps/, supabase/, README…) stays out of the apps.
const WEB = ['index.html', 'manifest.webmanifest', 'sw.js', 'config.local.js', 'css', 'js', 'icons', 'data'];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
let copied = 0;
for (const name of WEB) {
  const src = join(root, name);
  if (!existsSync(src)) { if (name !== 'config.local.js') console.warn(`  ! missing ${name}`); continue; }
  cpSync(src, join(out, name), { recursive: true });
  copied++;
}
if (!existsSync(join(root, 'config.local.js'))) console.warn('  ! no config.local.js — the apps will start in demo mode (copy config.example.js and add your keys)');
console.log(`Web files copied into apps/www (${copied} items). Website, APK and iOS now share the same code.`);
