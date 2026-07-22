# Native App Build Guide

Build and submit LeagueVault to the Apple App Store and Google Play Store.

## Prerequisites

### iOS
- Mac with macOS 13+ (Ventura or later)
- Xcode 15+ (free from Mac App Store)
- Apple Developer Account ($99/year) — https://developer.apple.com
- CocoaPods: `sudo gem install cocoapods`

### Android
- Android Studio (free) — https://developer.android.com/studio
- Google Play Developer Account ($25 one-time) — https://play.google.com/console
- Java Development Kit (JDK) 17+ (bundled with Android Studio)

### Both Platforms
- Node.js 18+ and npm installed
- This repository cloned locally

---

## How It Works

> **Dependency boundary:** The `@capacitor/*` packages in `package.json` and the `ios/`, `android/`, and `capacitor.config.ts` files are an intentional native-mobile product target. They are not imported by the web runtime (`server/`, `client/`, `shared/`), so dead-code/cleanup and dependency-audit tooling may flag them as unused — that is expected. Do not remove them or move them out of `dependencies`.

The native apps are thin shells that load the live production website (`https://leaguevault.app`) inside a native WebView. This means:

> **Note:** The runtime backend reads the production hostname from the `APP_DOMAIN` env var (defaults to `leaguevault.app`); see `docs/AGENTS.md`. The mobile entitlements and capacitor config below are **build-time** artifacts that intentionally stay hardcoded — they are baked into signed app bundles, not read from env.


- **No app store re-submission needed** for web updates — any changes deployed to the website are instantly reflected in the app.
- The native shell provides App Store/Play Store distribution, home screen icon, and access to native device APIs (camera, etc.).
- The `dist/public` directory contains a fallback copy of the web assets, but the app always loads the live URL.

---

## Build Steps

### 1. Install Dependencies

```bash
npm install
```

### 2. Build Web Assets

```bash
npm run build
```

This builds the frontend into `dist/public/`, which Capacitor uses as a fallback.

### 3. Sync Native Projects

```bash
npx cap sync
```

This copies web assets into the native projects and updates native plugin dependencies.

---

## iOS Build

### 4a. Install CocoaPods Dependencies

```bash
cd ios/App
pod install
cd ../..
```

### 5a. Open in Xcode

```bash
npx cap open ios
```

Or manually open `ios/App/App.xcworkspace` in Xcode.

### 6a. Configure Signing

1. In Xcode, select the **App** target in the project navigator.
2. Go to **Signing & Capabilities** tab.
3. Select your **Team** (your Apple Developer account).
4. Xcode will automatically manage provisioning profiles.

### 7a. Set Version Numbers

1. In Xcode, select the **App** target.
2. Go to **General** tab.
3. Set **Version** (e.g., `1.0.0`) and **Build** (e.g., `1`).
4. Increment **Build** for each App Store submission.

### 8a. App Icons

The app icons are in `ios/App/App/Assets.xcassets/AppIcon.appiconset/`.

To replace them:
1. Prepare a 1024x1024 PNG icon (no transparency, no rounded corners — iOS adds rounding).
2. Use an icon generator like https://www.appicon.co/ to create all required sizes.
3. Replace the contents of `AppIcon.appiconset/` with the generated files and `Contents.json`.

### 9a. Build and Archive

1. In Xcode, select **Product → Archive**.
2. Select a physical device or **Any iOS Device** as the build target (not a simulator).
3. Wait for the archive to complete.
4. In the Organizer window, click **Distribute App**.
5. Select **App Store Connect** and follow the prompts.

### 10a. Submit to App Store

1. Go to https://appstoreconnect.apple.com
2. Create a new app with bundle ID `app.leaguevault.mobile`.
3. Fill in the app metadata (screenshots, description, etc.).
4. Select the build you uploaded from Xcode.
5. Submit for review.

---

## Android Build

### 4b. Open in Android Studio

```bash
npx cap open android
```

Or manually open the `android/` directory in Android Studio.

### 5b. Wait for Gradle Sync

Android Studio will automatically download dependencies and sync the project. This may take a few minutes on the first run.

### 6b. App Icons

The app icons are in `android/app/src/main/res/mipmap-*/`.

To replace them:
1. In Android Studio, right-click `res` → **New → Image Asset**.
2. Select your 1024x1024 icon source.
3. Configure the foreground and background layers for adaptive icons.
4. Click **Finish** to generate all density sizes.

### 7b. Set Version Numbers

Edit `android/app/build.gradle`:
- `versionCode` — integer, increment for each Play Store upload (e.g., `1`, `2`, `3`)
- `versionName` — human-readable version string (e.g., `"1.0.0"`)

### 8b. Generate Signed APK/Bundle

1. In Android Studio: **Build → Generate Signed Bundle / APK**.
2. Select **Android App Bundle** (recommended by Google Play).
3. Create a new keystore or use an existing one.
   - **Keep your keystore file safe** — you need it for all future updates.
4. Select **release** build type.
5. Click **Finish**.

The signed `.aab` file will be in `android/app/release/`.

### 9b. Submit to Google Play

1. Go to https://play.google.com/console
2. Create a new app.
3. Fill in the app listing (screenshots, description, etc.).
4. Upload the `.aab` file under **Production → Create new release**.
5. Submit for review.

---

## Updating the App

For most updates, you only need to update the web app (deploy to leaguevault.app). The native apps will automatically show the latest content.

You only need to rebuild and resubmit the native apps when:
- Adding new native plugins (e.g., push notifications)
- Changing the app icon or splash screen
- Changing native configuration (permissions, bundle ID, etc.)
- Apple or Google requires an update for policy compliance

When rebuilding:
```bash
npm run build
npx cap sync
# Then open Xcode or Android Studio and follow the build steps above
```

---

## Configuration Reference

| Setting | Value |
|---------|-------|
| Bundle ID | `app.leaguevault.mobile` |
| App Name | `LeagueVault` |
| Production URL | `https://leaguevault.app` |
| Web Assets Dir | `dist/public` |
| iOS Min Target | iOS 14.0 |
| Android Min SDK | 23 (Android 6.0) |
| Android Target SDK | 35 |

---

## Deep Linking / Universal Links

The app is configured to handle links to `leaguevault.app` and all subdomains (`*.leaguevault.app`).

### iOS Setup

The entitlements file (`ios/App/App/App.entitlements`) declares associated domains. After getting your Apple Developer Team ID:

1. Open `server/index.ts` and replace `TEAM_ID` in the `apple-app-site-association` endpoint with your actual Apple Developer Team ID.
2. The server serves `/.well-known/apple-app-site-association` automatically.
3. In Xcode, verify **Signing & Capabilities → Associated Domains** shows `applinks:leaguevault.app`.

### Android Setup

The `AndroidManifest.xml` has intent filters with `autoVerify="true"` for `leaguevault.app`.

1. After generating your signing keystore, get the SHA-256 fingerprint:
   ```bash
   keytool -list -v -keystore your-keystore.jks
   ```
2. Open `server/index.ts` and add the SHA-256 fingerprint to the `sha256_cert_fingerprints` array in the `assetlinks.json` endpoint.
3. The server serves `/.well-known/assetlinks.json` automatically.

---

## Troubleshooting

### iOS: "No signing certificate" error
Make sure you're signed into your Apple Developer account in Xcode → Preferences → Accounts.

### iOS: CocoaPods errors
Run `cd ios/App && pod repo update && pod install` to refresh the CocoaPods cache.

### Android: Gradle sync failed
Try **File → Invalidate Caches → Restart** in Android Studio, then re-sync.

### WebView not loading
Ensure the production URL (`https://leaguevault.app`) is accessible. The app requires an internet connection.

### Camera not working
Make sure the app has camera permission granted in the device settings.
