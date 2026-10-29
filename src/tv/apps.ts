// TV apps the search button can target, with the link that opens each app's search.
// Links were tried on the TCL (see README, "Cómo se comporta esta tele").

export type AppId = 'youtube' | 'netflix' | 'prime' | 'disney' | 'max' | 'stremio';
/** Where "Buscar" goes: one of the apps, or "type and press Enter" for any other app. */
export type TargetId = AppId | 'enter';

export type SearchApp = {
  id: AppId;
  name: string;
  /** Package names of the app on the TV. */
  packages: string[];
  /** Link that opens the app's search screen, with the query when the app accepts it. */
  searchLink: (query: string) => string;
  /** The link can't carry the query: open the search screen, then type the query. */
  typeAfterOpen?: boolean;
  /**
   * The app can't be opened on its search screen. "Buscar" only opens the app (and keeps the
   * text); once it's open, the user opens its search with the TV remote and the text is typed there.
   */
  opensOnly?: boolean;
  /** The app drops accented letters and ñ, so send plain letters. */
  asciiOnly?: boolean;
};

const q = encodeURIComponent;

export const SEARCH_APPS: SearchApp[] = [
  {
    id: 'youtube',
    name: 'YouTube',
    packages: ['com.google.android.youtube.tv'],
    searchLink: (text) => `https://www.youtube.com/results?search_query=${q(text)}`,
    asciiOnly: true,
  },
  {
    id: 'netflix',
    name: 'Netflix',
    packages: ['com.netflix.ninja'],
    // No search link works on Android TV, and Netflix ignores links while it's open.
    searchLink: () => 'nflx://www.netflix.com/browse',
    opensOnly: true,
    asciiOnly: true,
  },
  {
    id: 'prime',
    name: 'Prime Video',
    packages: ['com.amazon.amazonvideo.livingroom'],
    searchLink: (text) => `https://app.primevideo.com/search?phrase=${q(text)}`,
  },
  {
    id: 'disney',
    name: 'Disney+',
    packages: ['com.disney.disneyplus'],
    searchLink: (text) => `disneyplus://www.disneyplus.com/search?q=${q(text)}`,
  },
  {
    id: 'max',
    name: 'HBO Max',
    packages: ['com.wbd.stream'],
    searchLink: () => 'https://play.max.com/search',
    typeAfterOpen: true,
    asciiOnly: true,
  },
  {
    id: 'stremio',
    name: 'Stremio',
    packages: ['com.stremio.one'],
    searchLink: (text) => `stremio:///search?search=${q(text)}`,
  },
];

export const DEFAULT_TARGET: TargetId = 'youtube';

const LAUNCHERS = new Set(['com.google.android.tvlauncher', 'com.google.android.apps.tv.launcherx']);

export function appById(id: TargetId): SearchApp | undefined {
  return SEARCH_APPS.find((app) => app.id === id);
}

export function appByPackage(pkg: string): SearchApp | undefined {
  return SEARCH_APPS.find((app) => app.packages.includes(pkg));
}

/** True for TV apps whose text field drops accented letters and ñ. */
export function asciiOnlyFor(pkg: string): boolean {
  return !!appByPackage(pkg)?.asciiOnly;
}

export function isLauncher(pkg: string): boolean {
  return pkg === '' || LAUNCHERS.has(pkg);
}

/**
 * What the selector shows on its own: the app open on the TV if it's one of ours,
 * YouTube on the home screen, and "type + Enter" inside any other app.
 */
export function autoTarget(tvApp: string): TargetId {
  const app = appByPackage(tvApp);
  if (app) return app.id;
  return isLauncher(tvApp) ? DEFAULT_TARGET : 'enter';
}
