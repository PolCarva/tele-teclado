// "Hay una versión nueva": version compare, the App Store / GitHub answers and the daily check.
// The App Store sample has the fields and values the live lookup returned on 2026-11-05
// (https://itunes.apple.com/lookup?id=6826423999&country=mx); the GitHub one follows the
// releases/latest answer for v1.1.1.

import assert from 'node:assert/strict';

import {
  APP_STORE_ID,
  CHECK_EVERY_MS,
  SNOOZE_MS,
  checkForUpdate,
  compareVersions,
  parseAppStoreLookup,
  parseGithubRelease,
  snoozeUpdate,
  type UpdateDeps,
} from '../../src/update/updates';

type AsyncTest = (name: string, fn: () => void | Promise<void>) => Promise<void>;

const appStore = (version: string, extra: Record<string, unknown> = {}) => ({
  resultCount: 1,
  results: [
    {
      trackId: Number(APP_STORE_ID),
      bundleId: 'com.pablocarvalho.tecladotv',
      version,
      trackViewUrl: 'https://apps.apple.com/mx/app/teclado-tv/id6826423999?uo=4',
      minimumOsVersion: '16.4',
      currentVersionReleaseDate: '2026-11-04T15:09:34Z',
      ...extra,
    },
  ],
});

const github = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/PolCarva/tele-teclado/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
  assets: [
    {
      name: 'Teclado-TV.apk',
      browser_download_url: `https://github.com/PolCarva/tele-teclado/releases/download/${tag}/Teclado-TV.apk`,
    },
  ],
  ...extra,
});

function memoryStore() {
  const data = new Map<string, string>();
  return {
    data,
    get: (key: string) => data.get(key) ?? null,
    set: (key: string, value: string | null) => (value === null ? data.delete(key) : data.set(key, value)),
  };
}

function deps(overrides: Partial<UpdateDeps> & { answers?: Record<string, unknown> }) {
  const calls: string[] = [];
  const { answers = {}, ...rest } = overrides;
  const base: UpdateDeps = {
    platform: 'ios',
    version: '1.1.1',
    installer: null,
    region: 'MX',
    osVersion: '18.2',
    fetchJson: async (url) => {
      calls.push(url);
      if (!(url in answers)) throw new Error(`offline: ${url}`);
      return answers[url];
    },
    playUpdateInfo: async () => {
      calls.push('play');
      return { available: false, versionCode: 0 };
    },
    store: memoryStore(),
    now: () => 1_800_000_000_000,
  };
  return { deps: { ...base, ...rest }, calls };
}

const LOOKUP_MX = `https://itunes.apple.com/lookup?id=${APP_STORE_ID}&country=mx`;
const LOOKUP_US = `https://itunes.apple.com/lookup?id=${APP_STORE_ID}`;
const GITHUB_LATEST = 'https://api.github.com/repos/PolCarva/tele-teclado/releases/latest';

export async function updateTests(test: AsyncTest) {
  await test('update: versions compare by number, not as text', () => {
    assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
    assert.equal(compareVersions('v1.2', '1.2.0'), 0);
    assert.equal(compareVersions('1.1.1', '1.2.0'), -1);
    assert.equal(compareVersions('2', '1.99'), 1);
  });

  await test('update: App Store lookup offers only a newer version this iPhone can install', () => {
    assert.equal(parseAppStoreLookup(appStore('1.1.1'), '1.1.1', '18.2'), null);
    assert.equal(parseAppStoreLookup(appStore('1.1.0'), '1.1.1', '18.2'), null);
    assert.deepEqual(parseAppStoreLookup(appStore('1.2.0'), '1.1.1', '18.2'), {
      source: 'appstore',
      id: '1.2.0',
      version: '1.2.0',
      url: 'https://apps.apple.com/mx/app/teclado-tv/id6826423999?uo=4',
    });
    assert.equal(parseAppStoreLookup(appStore('1.2.0', { minimumOsVersion: '19.0' }), '1.1.1', '18.2'), null);
    // Another app in the answer, or a link outside the App Store, is not trusted.
    assert.equal(parseAppStoreLookup(appStore('1.2.0', { trackId: 1 }), '1.1.1', '18.2'), null);
    assert.equal(
      parseAppStoreLookup(appStore('1.2.0', { trackViewUrl: 'https://example.com/x' }), '1.1.1', '18.2')?.url,
      `https://apps.apple.com/app/id${APP_STORE_ID}`,
    );
    assert.equal(parseAppStoreLookup({ resultCount: 0, results: [] }, '1.1.1', '18.2'), null);
    assert.equal(parseAppStoreLookup('garbage', '1.1.1', '18.2'), null);
  });

  await test('update: GitHub release goes straight to its APK, skips drafts and pre-releases', () => {
    assert.equal(parseGithubRelease(github('v1.1.1'), '1.1.1'), null);
    assert.deepEqual(parseGithubRelease(github('v1.2.0'), '1.1.1'), {
      source: 'github',
      id: '1.2.0',
      version: '1.2.0',
      url: 'https://github.com/PolCarva/tele-teclado/releases/download/v1.2.0/Teclado-TV.apk',
    });
    assert.equal(parseGithubRelease(github('v1.2.0', { prerelease: true }), '1.1.1'), null);
    assert.equal(parseGithubRelease(github('v1.2.0', { draft: true }), '1.1.1'), null);
    assert.equal(
      parseGithubRelease(github('v1.2.0', { assets: [] }), '1.1.1')?.url,
      'https://github.com/PolCarva/tele-teclado/releases/tag/v1.2.0',
    );
    assert.equal(
      parseGithubRelease(github('v1.2.0', { assets: [{ name: 'x.apk', browser_download_url: 'https://evil.example/x.apk' }] }), '1.1.1')?.url,
      'https://github.com/PolCarva/tele-teclado/releases/tag/v1.2.0',
    );
    assert.equal(parseGithubRelease(github('nightly'), '1.1.1'), null);
  });

  await test('update: iPhone asks its own store, then the default one if the app is not listed there', async () => {
    const found = deps({ answers: { [LOOKUP_MX]: appStore('1.2.0') } });
    assert.equal((await checkForUpdate(found.deps))?.version, '1.2.0');
    assert.deepEqual(found.calls, [LOOKUP_MX]);

    const fallback = deps({ answers: { [LOOKUP_MX]: { resultCount: 0, results: [] }, [LOOKUP_US]: appStore('1.2.0') } });
    assert.equal((await checkForUpdate(fallback.deps))?.source, 'appstore');
    assert.deepEqual(fallback.calls, [LOOKUP_MX, LOOKUP_US]);
  });

  await test('update: Android asks Google Play when installed from Play, GitHub otherwise', async () => {
    const play = deps({
      platform: 'android',
      installer: 'com.android.vending',
      playUpdateInfo: async () => ({ available: true, versionCode: 7 }),
    });
    assert.deepEqual(await checkForUpdate(play.deps), { source: 'play', id: 'play-7' });
    assert.deepEqual(play.calls, []);

    for (const installer of [null, 'com.google.android.packageinstaller', 'com.android.chrome']) {
      const apk = deps({ platform: 'android', installer, answers: { [GITHUB_LATEST]: github('v1.2.0') } });
      assert.equal((await checkForUpdate(apk.deps))?.source, 'github');
      assert.deepEqual(apk.calls, [GITHUB_LATEST]);
    }
  });

  await test('update: one network check a day, redone when the installed version changes', async () => {
    let now = 1_800_000_000_000;
    const t = deps({ answers: { [LOOKUP_MX]: appStore('1.2.0') }, now: () => now });
    await checkForUpdate(t.deps);
    now += CHECK_EVERY_MS - 1;
    assert.equal((await checkForUpdate(t.deps))?.version, '1.2.0');
    assert.equal(t.calls.length, 1);
    // Updated to 1.2.0: the cached answer is for the old version, so ask again (and offer nothing).
    assert.equal(await checkForUpdate({ ...t.deps, version: '1.2.0' }), null);
    assert.equal(t.calls.length, 2);
    now += CHECK_EVERY_MS;
    await checkForUpdate({ ...t.deps, version: '1.2.0' });
    assert.equal(t.calls.length, 3);
  });

  await test('update: no network means no notice, and nothing is cached', async () => {
    const t = deps({ answers: {} });
    assert.equal(await checkForUpdate(t.deps), null);
    assert.equal((t.deps.store as ReturnType<typeof memoryStore>).data.size, 0);
    const play = deps({
      platform: 'android',
      installer: 'com.android.vending',
      playUpdateInfo: async () => {
        throw new Error('APP_NOT_OWNED');
      },
    });
    assert.equal(await checkForUpdate(play.deps), null);
  });

  await test('update: "Ahora no" hides that version for a week, but not a newer one', async () => {
    let now = 1_800_000_000_000;
    const store = memoryStore();
    const answers: Record<string, unknown> = { [LOOKUP_MX]: appStore('1.2.0') };
    const t = deps({ answers, store, now: () => now });
    const first = await checkForUpdate(t.deps);
    assert.ok(first);
    snoozeUpdate(store, first, now);
    assert.equal(await checkForUpdate(t.deps), null);
    now += SNOOZE_MS - 1;
    assert.equal(await checkForUpdate(t.deps, { force: true }), null);
    answers[LOOKUP_MX] = appStore('1.3.0');
    assert.equal((await checkForUpdate(t.deps, { force: true }))?.version, '1.3.0');
    answers[LOOKUP_MX] = appStore('1.2.0');
    now += 2;
    assert.equal((await checkForUpdate(t.deps, { force: true }))?.version, '1.2.0');
  });
}
