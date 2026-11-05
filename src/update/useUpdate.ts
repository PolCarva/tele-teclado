import { useEffect, useState } from 'react';
import { Linking, Platform } from 'react-native';

import TvRemote from '../../modules/tv-remote/src/TvRemoteModule';
import { settings } from '../tv/nativeTransport';
import { ANDROID_PACKAGE, checkForUpdate, snoozeUpdate, type AvailableUpdate } from './updates';

// Dev only: `EXPO_PUBLIC_UPDATE_TEST_VERSION=1.0.0 npx expo start` makes the app act as that version
// (and skip the daily cache), to see the notice. Release builds ignore it.
const TEST_VERSION = __DEV__ ? process.env.EXPO_PUBLIC_UPDATE_TEST_VERSION : undefined;

async function fetchJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // The App Store answers with text/javascript, so parse the text instead of trusting the type.
    return JSON.parse(await response.text());
  } finally {
    clearTimeout(timer);
  }
}

let pending: Promise<AvailableUpdate | null> | null = null;

/** One check per app launch (and at most one network call a day, see checkForUpdate). */
function checkOnce(): Promise<AvailableUpdate | null> {
  pending ??= (async () => {
    const info = TvRemote.appInfo();
    return checkForUpdate(
      {
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
        version: TEST_VERSION || info.version,
        installer: info.installer ?? null,
        region: info.region ?? null,
        osVersion: String(Platform.Version),
        fetchJson,
        playUpdateInfo: () => TvRemote.playUpdateInfo(),
        store: settings,
        now: () => Date.now(),
      },
      { force: !!TEST_VERSION },
    );
  })().catch(() => null);
  return pending;
}

async function install(update: AvailableUpdate): Promise<void> {
  if (update.source === 'play') {
    try {
      // Play shows its own screen; when accepted it installs the update and restarts the app.
      await TvRemote.startPlayUpdate();
    } catch {
      await Linking.openURL(`https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`);
    }
    return;
  }
  if (update.url) await Linking.openURL(update.url);
}

/** The newer version to offer, if any, with "Actualizar" and "Ahora no". */
export function useUpdate() {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);

  useEffect(() => {
    let alive = true;
    void checkOnce().then((found) => {
      if (alive) setUpdate(found);
    });
    return () => {
      alive = false;
    };
  }, []);

  return {
    update,
    install: () => {
      if (update) void install(update).catch(() => undefined);
    },
    later: () => {
      if (!update) return;
      snoozeUpdate(settings, update, Date.now());
      setUpdate(null);
    },
  };
}
