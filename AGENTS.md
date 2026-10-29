This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## This project

Teclado TV: one-screen app that types into the focused text field of a TV. It talks several brands' protocols: Android TV Remote v2, Samsung Tizen (WebSocket), LG webOS (SSAP), Roku ECP, Sony Scalar Web API, Panasonic VIERA (SOAP). Read README.md first.

- One screen in `App.tsx`; no Expo Router on purpose (keep it that way unless screens are added).
- Protocol/transport logic is TypeScript, free of React Native imports and shared with the Mac test tool (`npm run tv -- …`):
  - `src/protocol/` — Android TV Remote v2 (pairing, session, protobuf, SHA-256).
  - `src/net/` — shared transports over raw sockets: HTTP/1.1, WebSocket, MQTT, SHA-1/MD5/HMAC, AES-128-CBC, URL parser.
  - `src/brands/` — one connector per brand behind the `Driver`/`TvSession` interface in `types.ts`, plus multi-brand discovery in `discovery.ts`. `TvController` is brand-agnostic.
- Native code is only in `modules/tv-remote/` (certificate; TCP/TLS/client-cert sockets; mDNS/SSDP/port-probe discovery; Wi-Fi info; random bytes; settings): Kotlin for Android, Swift for iOS. Keep both sides' functions in sync with `src/TvRemoteModule.ts`. All TV protocols run over these raw sockets, so they are not subject to Android cleartext policy or iOS ATS.
- To add a brand: write `src/brands/<brand>.ts` implementing `Driver`, register it in `src/brands/index.ts`, and add a simulated TV + test in `scripts/tests/`. Base it on real protocol sources, not memory.
- Check changes with `npm run selftest` (crypto vs node, protobuf vs reference bytes, HTTP/WS/MQTT vs real servers, each brand vs a simulated TV), then Android TV against the real TV with `npm run tv -- type "hola"`.
- Build the APK with `npm run build:android` (output: `dist/Teclado-TV.apk`). iOS ships through EAS + TestFlight: `eas build -p ios --profile production --auto-submit`.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md
