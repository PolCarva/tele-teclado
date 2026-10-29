// Turns "the text in the phone box changed" into "delete N characters on the TV, then type X".
// The TV inserts at its cursor, so we only send the difference, never the whole text again.

/** TV apps that drop accented letters and ñ. For them we send the plain letter instead. */
const ASCII_ONLY_APPS = new Set([
  'com.google.android.youtube.tv',
  'com.google.android.youtube.tvkids',
  'com.google.android.youtube.tvmusic',
]);

const PLAIN: Record<string, string> = {
  á: 'a', à: 'a', â: 'a', ä: 'a', ã: 'a', å: 'a',
  é: 'e', è: 'e', ê: 'e', ë: 'e',
  í: 'i', ì: 'i', î: 'i', ï: 'i',
  ó: 'o', ò: 'o', ô: 'o', ö: 'o', õ: 'o',
  ú: 'u', ù: 'u', û: 'u', ü: 'u',
  ñ: 'n', ç: 'c',
  Á: 'A', À: 'A', Â: 'A', Ä: 'A', Ã: 'A', Å: 'A',
  É: 'E', È: 'E', Ê: 'E', Ë: 'E',
  Í: 'I', Ì: 'I', Î: 'I', Ï: 'I',
  Ó: 'O', Ò: 'O', Ô: 'O', Ö: 'O', Õ: 'O',
  Ú: 'U', Ù: 'U', Û: 'U', Ü: 'U',
  Ñ: 'N', Ç: 'C',
  '“': '"', '”': '"', '‘': "'", '’': "'", '–': '-', '—': '-', '…': '...',
};

export function needsAsciiOnly(appPackage: string): boolean {
  return ASCII_ONLY_APPS.has(appPackage);
}

/** What actually gets typed on the TV for this text. */
export function textForTv(text: string, asciiOnly: boolean): string {
  // Phone keyboards may insert non-breaking spaces; the TV wants plain ones.
  let out = text.replace(/[  ]/g, ' ').replace(/\r?\n/g, ' ');
  if (asciiOnly) {
    out = Array.from(out)
      .map((ch) => PLAIN[ch] ?? ch)
      .filter((ch) => ch >= ' ' && ch <= '~')
      .join('');
  }
  return out;
}

/** Characters to delete on the TV (from the end) and text to type after that. */
export function diffText(before: string, after: string): { deletes: number; insert: string } {
  const a = Array.from(before);
  const b = Array.from(after);
  let same = 0;
  while (same < a.length && same < b.length && a[same] === b[same]) same++;
  return { deletes: a.length - same, insert: b.slice(same).join('') };
}
