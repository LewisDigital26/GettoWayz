# GettoWayz — three builds, one code

| Build | Where it comes from | How you get it |
|---|---|---|
| **Web** | the repo root (`index.html`, `js/`, `css/`, `icons/`…) | push to `main` → live at lewisdigital26.github.io/GettoWayz/ |
| **Android APK** | `apps/android/`, filled from the repo root | `npm run android` → Android Studio ▶ / Build APK |
| **iOS app** | `apps/ios/`, filled from the repo root | `npm run ios` on a Mac or cloud Mac → Xcode ▶ |

**All app code lives in the repo root.** Change it there once and all three builds get it.
`apps/www/` is a throwaway copy made by `scripts/sync-web.mjs` before each build — never edit it.

## First-time setup on your PC (Android)

In PowerShell:

```powershell
cd $HOME\Desktop\GW
git clone https://github.com/LewisDigital26/GettoWayz.git
cd GettoWayz\apps
npm install
npx cap add android
npm run android
npx cap open android
```

Android Studio opens → green ▶ to run on the emulator or your phone, or **Build › Build App Bundle(s)/APK(s) › Build APK(s)**.
The APK lands in `apps\android\app\build\outputs\apk\debug\app-debug.apk`.
It uses the same app id as your old build (`com.lewisdigital.ghettowayz`), so it installs over it.

Then commit the new `apps/android` folder so it's saved on GitHub:

```powershell
cd ..
git add apps/android
git commit -m "Add Android project"
git push
```

## First-time setup on a Mac / cloud Mac (iOS)

Needs Xcode (free from the Mac App Store) and Node.js.

```bash
git clone https://github.com/LewisDigital26/GettoWayz.git
cd GettoWayz/apps
npm install
npx cap add ios
npm run ios
npx cap open ios
```

Xcode opens → pick an iPhone simulator at the top → ▶. To run on your own iPhone, plug it in, choose it as the target, and sign in with your Apple ID under **Signing & Capabilities** (free Apple IDs expire after 7 days).
Commit `apps/ios` afterwards the same way as Android.

## Every time after a change

1. Make the change in the repo root (or ask Claude to) and push — the **website** updates by itself.
2. **Android**: `git pull`, then in `apps`: `npm run android`, then ▶ in Android Studio.
3. **iOS**: `git pull`, then in `apps`: `npm run ios`, then ▶ in Xcode.

`npm run android` / `npm run ios` copy the latest web code in, sync Capacitor, and make sure the location permissions are set
(Android manifest; iOS `Info.plist` strings Apple requires before an app may ask for location).

## Keys

`config.local.js` in the repo root is copied into both apps. If it's missing, the apps start in demo mode.
