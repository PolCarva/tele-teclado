// Is there a newer version of the app? It asks the place the app was installed from:
// - iPhone: the App Store lookup (https://itunes.apple.com/lookup?id=…&country=…). Apple documents the
//   endpoint and `country` (two letters, default US) in its Search API docs; the result's `version`,
//   `trackViewUrl` and `minimumOsVersion` were checked live on 2026-11-05 for the mx, uy and us stores.
// - Android installed from Google Play: Play's in-app updates API (native, `playUpdateInfo`).
// - Android installed from the APK: the latest GitHub release (its tag and the Teclado-TV.apk asset).
// At most one check a day. Nothing about the phone, the TV or what is typed is sent.
// No React Native imports here, so the self-test can run it.

export const APP_STORE_ID = '6826423999';
export const GITHUB_REPO = 'PolCarva/tele-teclado';
export const ANDROID_PACKAGE = 'com.pablocarvalho.tecladotv';
/** Installer package of apps installed from Google Play. */
export const PLAY_INSTALLER = 'com.android.vending';

export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
/** "Ahora no" hides the notice for this long (or until an even newer version comes out). */
export const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

const CHECK_KEY = 'update.check';
const SNOOZE_KEY = 'update.snoozed';

export type UpdateSource = 'appstore' | 'play' | 'github';

export interface AvailableUpdate {
  source: UpdateSource;
  /** Identifies this update for "Ahora no": the version, or Play's version code. */
  id: string;
  /** The new version's name, when the source tells it (Play only gives a version code). */
  version?: string;
  /** Where "Actualizar" goes (App Store page or the APK). Play opens its own screen instead. */
  url?: string;
}

export interface UpdateStore {
  get(key: string): string | null;
  set(key: string, value: string | null): void;
}

export interface UpdateDeps {
  platform: 'ios' | 'android';
  /** The installed version, e.g. "1.1.1". */
  version: string;
  /** Android: the package that installed the app (null for adb). iOS: null. */
  installer: string | null;
  /** The phone's region, two letters, for the App Store country. */
  region: string | null;
  /** iOS version, to skip an update the phone can't install. */
  osVersion: string;
  fetchJson(url: string, headers?: Record<string, string>): Promise<unknown>;
  playUpdateInfo(): Promise<{ available: boolean; versionCode: number }>;
  store: UpdateStore;
  now(): number;
}

/** Compares dotted versions ("v1.10.0" > "1.9"); missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .map((p) => Number.parseInt(p, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

const isVersion = (v: unknown): v is string => typeof v === 'string' && /^v?\d+(\.\d+)*$/.test(v.trim());

/** The App Store lookup result, if it is newer than `current` and installs on this iOS version. */
export function parseAppStoreLookup(json: unknown, current: string, osVersion: string): AvailableUpdate | null {
  const results = (json as { results?: unknown })?.results;
  if (!Array.isArray(results)) return null;
  const app = results.find((r) => String((r as { trackId?: unknown })?.trackId) === APP_STORE_ID) as
    | { version?: unknown; trackViewUrl?: unknown; minimumOsVersion?: unknown }
    | undefined;
  if (!app || !isVersion(app.version) || compareVersions(app.version, current) <= 0) return null;
  if (isVersion(app.minimumOsVersion) && osVersion && compareVersions(osVersion, app.minimumOsVersion) < 0) return null;
  const url =
    typeof app.trackViewUrl === 'string' && app.trackViewUrl.startsWith('https://apps.apple.com/')
      ? app.trackViewUrl
      : `https://apps.apple.com/app/id${APP_STORE_ID}`;
  return { source: 'appstore', id: app.version, version: app.version, url };
}

/** The latest GitHub release, if it is newer than `current`. Goes straight to its APK when it has one. */
export function parseGithubRelease(json: unknown, current: string): AvailableUpdate | null {
  const release = json as {
    tag_name?: unknown;
    html_url?: unknown;
    draft?: unknown;
    prerelease?: unknown;
    assets?: { name?: unknown; browser_download_url?: unknown }[];
  };
  if (!release || release.draft === true || release.prerelease === true || !isVersion(release.tag_name)) return null;
  const version = release.tag_name.trim().replace(/^v/i, '');
  if (compareVersions(version, current) <= 0) return null;
  const prefix = `https://github.com/${GITHUB_REPO}/`;
  const apk = (Array.isArray(release.assets) ? release.assets : []).find(
    (a) => typeof a?.name === 'string' && a.name.toLowerCase().endsWith('.apk'),
  )?.browser_download_url;
  const page = release.html_url;
  const url =
    typeof apk === 'string' && apk.startsWith(prefix)
      ? apk
      : typeof page === 'string' && page.startsWith(prefix)
        ? page
        : `${prefix}releases/latest`;
  return { source: 'github', id: version, version, url };
}

export function sourceFor(platform: UpdateDeps['platform'], installer: string | null): UpdateSource {
  if (platform === 'ios') return 'appstore';
  return installer === PLAY_INSTALLER ? 'play' : 'github';
}

async function lookup(deps: UpdateDeps): Promise<AvailableUpdate | null> {
  switch (sourceFor(deps.platform, deps.installer)) {
    case 'appstore': {
      const base = `https://itunes.apple.com/lookup?id=${APP_STORE_ID}`;
      const country = deps.region && /^[A-Za-z]{2}$/.test(deps.region) ? deps.region.toLowerCase() : null;
      let json = await deps.fetchJson(country ? `${base}&country=${country}` : base);
      // The phone's region may not be the store's country: fall back to the default (US) store.
      if (country && Number((json as { resultCount?: unknown })?.resultCount) === 0) json = await deps.fetchJson(base);
      return parseAppStoreLookup(json, deps.version, deps.osVersion);
    }
    case 'play': {
      const info = await deps.playUpdateInfo();
      return info.available ? { source: 'play', id: `play-${info.versionCode}` } : null;
    }
    case 'github': {
      const json = await deps.fetchJson(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
        Accept: 'application/vnd.github+json',
      });
      return parseGithubRelease(json, deps.version);
    }
  }
}

function readJson<T>(store: UpdateStore, key: string): T | null {
  try {
    const raw = store.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/**
 * The update to offer, or null. Asks at most once a day (the answer is kept for the day, and
 * thrown away when the installed version changes). Never throws: no network means no notice.
 */
export async function checkForUpdate(deps: UpdateDeps, options: { force?: boolean } = {}): Promise<AvailableUpdate | null> {
  const now = deps.now();
  type Check = { at: number; installed: string; update: AvailableUpdate | null };
  const cached = readJson<Check>(deps.store, CHECK_KEY);
  let update: AvailableUpdate | null;
  if (!options.force && cached && cached.installed === deps.version && now - cached.at >= 0 && now - cached.at < CHECK_EVERY_MS) {
    update = cached.update;
  } else {
    try {
      update = await lookup(deps);
    } catch {
      return null;
    }
    deps.store.set(CHECK_KEY, JSON.stringify({ at: now, installed: deps.version, update } satisfies Check));
  }
  if (!update) return null;
  if (update.version && compareVersions(update.version, deps.version) <= 0) return null;
  const snoozed = readJson<{ id: string; at: number }>(deps.store, SNOOZE_KEY);
  if (snoozed && snoozed.id === update.id && now - snoozed.at >= 0 && now - snoozed.at < SNOOZE_MS) return null;
  return update;
}

/** "Ahora no": hide this update for a while. */
export function snoozeUpdate(store: UpdateStore, update: AvailableUpdate, now: number): void {
  store.set(SNOOZE_KEY, JSON.stringify({ id: update.id, at: now }));
}
