// Adds the location permissions GettoWayz needs to the native projects after `npx cap add` / `npx cap sync`.
// Safe to run any number of times. Usage: node scripts/patch-native.mjs [android|ios]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const apps = join(dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv[2];

// ---- iOS: Info.plist usage strings (Apple rejects/blocks location without these) ----
const IOS_KEYS = {
  NSLocationWhenInUseUsageDescription: 'GettoWayz uses your location to plan routes, guide you turn by turn and show nearby alerts.',
  NSLocationAlwaysAndWhenInUseUsageDescription: 'GettoWayz uses your location while a trip is running, including when the screen is off, so turn-by-turn guidance and trip sharing with friends you chose keep working.',
};
function patchIos() {
  const plist = join(apps, 'ios', 'App', 'App', 'Info.plist');
  if (!existsSync(plist)) { console.log('iOS: no ios/ project yet — run `npx cap add ios` first (on a Mac or cloud Mac).'); return; }
  let s = readFileSync(plist, 'utf8');
  let added = 0;
  for (const [k, v] of Object.entries(IOS_KEYS)) {
    if (s.includes(`<key>${k}</key>`)) continue;
    s = s.replace(/<\/dict>\s*<\/plist>\s*$/, `\t<key>${k}</key>\n\t<string>${v}</string>\n</dict>\n</plist>\n`);
    added++;
  }
  writeFileSync(plist, s);
  console.log(`iOS: Info.plist location strings ${added ? `added (${added})` : 'already present'}.`);
}

// ---- Android: manifest permissions ----
const ANDROID_PERMS = [
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.INTERNET',
];
function patchAndroid() {
  const manifest = join(apps, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  if (!existsSync(manifest)) { console.log('Android: no android/ project yet — run `npx cap add android` first.'); return; }
  let s = readFileSync(manifest, 'utf8');
  const missing = ANDROID_PERMS.filter((p) => !s.includes(`"${p}"`));
  if (missing.length) s = s.replace(/<\/manifest>\s*$/, `${missing.map((p) => `    <uses-permission android:name="${p}" />`).join('\n')}\n</manifest>\n`);
  writeFileSync(manifest, s);
  console.log(`Android: manifest permissions ${missing.length ? `added (${missing.length})` : 'already present'}.`);
}

if (!only || only === 'ios') patchIos();
if (!only || only === 'android') patchAndroid();
