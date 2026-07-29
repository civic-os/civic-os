# PWA Design Document

> **Version**: v0.69.0
> **Status**: Implemented
> **Author**: Daniel Kurin

## Overview

Civic OS supports **thin PWA** (Progressive Web App) — app shell caching and installability — without offline data or API caching. PWA is off by default and opt-in per instance via `PWA_ENABLED=true` Docker env var.

## Design Decisions

### Why "Thin" PWA (No Data Caching)

Civic OS is a multi-tenant meta-application where every deployment has different data structures, permissions, and real-time requirements. Caching PostgREST API responses in the service worker would:

1. **Create stale data risks** — CRUD operations on one tab could show stale data on another
2. **Conflict with RLS** — Row-Level Security means different users see different data for the same endpoint
3. **Add complexity without proportional value** — the primary ask is "add to home screen" + fast repeat loads

The thin approach gives installability and instant app shell loads (HTML/CSS/JS) while ensuring all API data is always fresh from the database.

### provideServiceWorker vs Manual Registration

Angular's `provideServiceWorker()` with the ngsw (Angular Service Worker) was chosen over manual `navigator.serviceWorker.register()` because:

- Automatic hash-based cache busting for all built assets
- Built-in `SwUpdate` service for detecting and applying updates
- Zero custom SW code to maintain — the ngsw-config.json declaratively defines what to cache

### Single PwaService

All PWA state (online/offline, install prompt, SW updates, cleanup) is centralized in one `PwaService` rather than scattered across components. This ensures:

- Install prompt (`beforeinstallprompt`) is captured exactly once at app startup
- SW update detection has a single subscription
- Cleanup logic (unregistering SWs when PWA is disabled) runs in one place

## Architecture

### Runtime Toggle Mechanism

```
Docker ENV: PWA_ENABLED=true
    ↓
docker-entrypoint.sh: injects window.civicOsConfig.pwa.enabled = true
    ↓
runtime.ts: getPwaConfig() reads window.civicOsConfig.pwa || environment.pwa
    ↓
app.config.ts: provideServiceWorker('ngsw-worker.js', { enabled: !isDevMode() && getPwaConfig().enabled })
    ↓
PwaService constructor: if (!pwaEnabled) → unregisterAllServiceWorkers() and return early
```

### ngsw-config.json

- `assetGroups[0]` "appShell": **prefetch** — `/index.html`, `/*.css`, `/*.js`
- `assetGroups[1]` "assets": **lazy** — `/assets/**`, `/favicon.ico`, Google Fonts
- **No `dataGroups`** — all API calls pass through to network untouched

**Exclusions by design:**
- `silent-check-sso.html` — not matched by `/*.css` or `/*.js` patterns, and correctly excluded (verified in build output)
- Keycloak/PostgREST API calls — no `dataGroups` means the SW ignores all non-asset requests

### Install UX Flow

```
1. Browser fires `beforeinstallprompt` event
   → PwaService stashes the event, sets installable = true

2. First-visit banner appears (OfflineBannerComponent + PwaInstallBannerComponent)
   → User clicks "Install" → PwaService.promptInstall() triggers browser prompt
   → User clicks "X" → PwaService.dismissInstallBanner() → localStorage remembers

3. Settings fallback: Settings > Preferences > "Install App" section
   → Visible when installable && !installed
   → Survives banner dismissal (different computed signal)
```

### Update Flow

```
1. Angular SW detects new ngsw.json hash on periodic check
   → SwUpdate.versionUpdates emits VERSION_READY event

2. PwaService sets updateAvailable = true

3. PwaUpdateToastComponent shows fixed-position toast (bottom-right)
   → User clicks "Reload" → document.location.reload()
```

### Security Considerations

- `silent-check-sso.html` is NOT cached (Keycloak SSO iframe must always go to network)
- All PostgREST API calls bypass the SW (no `dataGroups`)
- Active SW unregistration when `PWA_ENABLED=false` prevents zombie workers from a previous deployment
- Manifest `<link>` tag only injected by docker-entrypoint.sh when `PWA_ENABLED=true`

### Dynamic theme-color

The `<meta name="theme-color">` is NOT injected statically in `index.html`. Instead:

- **Manifest** has hardcoded `theme_color: "#ffffff"` for install/splash screen (one-time)
- **ThemeService** dynamically creates/updates the meta tag at runtime using the current DaisyUI theme's `--color-base-300` (navbar background)
- This runs for ALL users, not just PWA — it colors the mobile address bar in regular browsers too

## Browser Compatibility

The PWA install experience varies by browser:

| Browser | Install Banner | SW Caching | Install Method |
|---------|---------------|------------|----------------|
| Chrome / Edge / Samsung Internet | `beforeinstallprompt` event fires, in-app banner shown | Yes | In-app banner or browser menu |
| Firefox (Android) | No `beforeinstallprompt` event | Yes | Browser menu > "Add to Home Screen" |
| Safari / iOS | No `beforeinstallprompt` event | Yes (with limitations) | Share > "Add to Home Screen" |

**Key points:**
- The `beforeinstallprompt` API is **Chromium-only**. Firefox and Safari users will never see the in-app install banner or the Settings > Install App option.
- Service worker caching (fast repeat loads, offline app shell) works across all modern browsers.
- On iOS, Safari is the only browser engine allowed to register service workers (even Chrome on iOS uses WebKit).

## Docker Integration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PWA_ENABLED` | `false` | Enable/disable PWA features |
| `PWA_APP_NAME` | `APP_TITLE` | App name in manifest and install banners. Falls back to `APP_TITLE`, then `"Civic OS"`. |

### docker-entrypoint.sh Changes

1. Logs `PWA_ENABLED` in configuration echo block
2. Adds `pwa: { enabled: ... }` to `window.civicOsConfig`
3. When `PWA_ENABLED=true`: injects `<link rel="manifest">` into index.html and substitutes `PWA_APP_TITLE_PLACEHOLDER` in manifest.webmanifest
4. **Rehashes `index.html` in `ngsw.json`** (unconditionally) — because the config injection, title replacement, favicon URL, and manifest link all modify `index.html` after the Angular build, the SHA-1 hash in `ngsw.json` becomes stale. The entrypoint recomputes the hash with `sha1sum` and patches `ngsw.json` so the service worker accepts the modified file. This runs even when `PWA_ENABLED=false` because `ngsw.json` always exists in the build output and the SW is never registered when disabled, so there is no downside.

### nginx.conf Changes

No-cache headers for SW files:
- `/ngsw-worker.js` — must never be cached by CDN/proxy
- `/ngsw.json` — hash manifest, must always be fresh
- `/manifest.webmanifest` — app metadata

## Icons

PWA icons go in `src/assets/icons/`:
- `icon-192x192.png` — required for Android install
- `icon-512x512.png` — required for splash screen
- `icon-maskable-512x512.png` — safe-zone variant for adaptive icons

These must be provided by the deployer. The manifest references them but they are not included in the repo.

### Manifest Name Substitution

The manifest `name` and `short_name` use a placeholder (`PWA_APP_TITLE_PLACEHOLDER`) that the entrypoint substitutes at container start. The substitution cascades: `PWA_APP_NAME` → `APP_TITLE` → `"Civic OS"`.

## i18n

8 translation keys added to `en.translations.ts`:
- `pwa.offline_message`, `pwa.install_prompt`, `pwa.install_action`, `pwa.install_app`
- `pwa.install_description`, `pwa.update_available`, `pwa.update_reload`
- `a11y.dismiss_install`

`pwa.install_prompt` and `pwa.install_description` use `{{appName}}` interpolation so the configured app name appears in install banners and the Settings modal.

Migration `v0-69-0-pwa-translations` provides translations for es, ar, fr, de, ps.
Migration `v0-69-1-pwa-app-name-translations` updates `install_prompt` and `install_description` to use `{{appName}}`.
