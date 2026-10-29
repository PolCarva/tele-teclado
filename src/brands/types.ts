// What every TV brand's connector provides, so the controller and the screen don't care
// which protocol a TV speaks. Each brand lives in its own file next to this one.

import type { MdnsService, SsdpReply, Transport } from '../protocol/transport';

export type BrandId =
  | 'androidtv'
  | 'samsung'
  | 'lg'
  | 'roku'
  | 'firetv'
  | 'sony'
  | 'panasonic'
  | 'hisense'
  | 'vizio'
  | 'philips'
  | 'kodi'
  | 'appletv'
  | 'lgnetcast';

/** A TV found on the Wi-Fi (or saved from an earlier run). */
export type TvInfo = {
  brand: BrandId;
  host: string;
  /** Name shown to the user (the TV's own name when it announces one). */
  name: string;
  /** Stable id when the TV has one (UUID, MAC, serial), so a new IP address is the same TV. */
  id?: string;
  model?: string;
  /** Protocol details found during discovery that the connector needs (ports, API version…). */
  hints?: Record<string, string>;
};

/** Saved per TV: tokens, client keys, cookies… Whatever the brand needs to skip pairing next time. */
export type Credentials = Record<string, string>;

/** What the user has to do on the TV to pair. */
export type PairingPrompt =
  /** The TV shows a code; the user types it on the phone. */
  | { kind: 'code'; length: number; charset: 'hex' | 'digits'; title: string; message: string }
  /** The TV shows "allow this device?"; the user accepts with the TV remote. */
  | { kind: 'accept'; title: string; message: string };

export class PairingRequired extends Error {
  constructor(message = 'Hay que vincular el celular con la tele') {
    super(message);
  }
}

/** The TV is there but a setting blocks the phone; `message` tells the user what to change. */
export class TvSetupNeeded extends Error {}

export class PairingError extends Error {
  constructor(
    message: string,
    readonly code: 'bad_code' | 'rejected' | 'closed' | 'timeout',
  ) {
    super(message);
  }
}

/** Why a session ended: the TV doesn't know this phone (anymore), the network failed, or we closed it. */
export type CloseReason = 'needs_pairing' | 'network' | 'closed';

export type SessionEvents = {
  onClose(reason: CloseReason, detail?: string | null): void;
  /** Android TV: package of the app in front (e.g. com.google.android.youtube.tv). */
  onApp?(app: string): void;
  /** The TV opened or closed its on-screen keyboard, with the field's text when it tells us. */
  onKeyboard?(state: { visible: boolean; text?: string }): void;
  /** While connecting: the TV is showing its "allow?" prompt. */
  onPrompt?(prompt: PairingPrompt): void;
  onDebug?(line: string): void;
};

/**
 * - `insert`: text goes in at the TV's cursor; the connector gets what to delete and type.
 * - `replace`: the connector sends the whole text each time.
 * - `append`: the TV only takes added text (nothing can be deleted from the phone), so the
 *   phone box is a draft that's sent as a whole with "Enviar".
 */
export type TextMode = 'insert' | 'replace' | 'append';

export type NavKey = 'enter' | 'back' | 'up' | 'down' | 'left' | 'right' | 'home';

/** An open connection to one TV. */
export interface TvSession {
  readonly textMode: TextMode;
  /** Ready to take text (some TVs need a moment after connecting). */
  readonly ready: boolean;
  readonly closed: boolean;
  /** Mirror the phone box: `before` is what the TV field has from us, `after` what it should have. */
  updateText(before: string, after: string): void;
  /** Confirm the text (Enter / done / search). */
  submit(): void;
  close(): void;
  /** Optional extras. */
  sendKey?(key: NavKey): void;
  /** Android TV: open a deep link (search inside an app). */
  openLink?(url: string): void;
  /** Android TV: app currently in front. */
  readonly currentApp?: string;
}

/** A pairing in progress (the TV is showing a code or an "allow?" prompt). */
export interface PairingFlow {
  readonly prompt: PairingPrompt;
  /** For `code` prompts: send what the user typed. Resolves with what to save. */
  submit?(code: string): Promise<Credentials>;
  /** For `accept` prompts: resolves once the user accepted on the TV. */
  accepted?: Promise<Credentials>;
  cancel(): void;
  /** The TV closed its pairing screen. */
  onClose(listener: () => void): void;
}

export type DriverContext = {
  transport: Transport;
  /** Name this phone shows on the TV ("Teclado TV"). */
  clientName: string;
};

/** Ways a connector recognises its TVs on the Wi-Fi. All optional. */
export type DiscoverySpec = {
  mdnsTypes?: string[];
  ssdpTargets?: string[];
  /** Ports to try on every address of the Wi-Fi when nothing announces itself. */
  probePorts?: number[];
  fromMdns?(service: MdnsService, ctx: DriverContext): TvInfo | null | Promise<TvInfo | null>;
  /** AirPlay / Cast TXT "manufacturer" values (regex) that hint this brand: its ports get probed on that address. */
  manufacturer?: RegExp;
  /** May fetch the device description to confirm (async). */
  fromSsdp?(reply: SsdpReply, headers: Record<string, string>, ctx: DriverContext): Promise<TvInfo | null>;
  /** An open port from the probe: confirm it's this brand (e.g. ask for device info). */
  fromPort?(host: string, port: number, ctx: DriverContext): Promise<TvInfo | null>;
};

export interface Driver {
  readonly brand: BrandId;
  /** "Samsung", "LG"… */
  readonly label: string;
  /** Higher wins when one address matches several connectors (e.g. Android TV over Sony REST). */
  readonly priority: number;
  readonly discovery: DiscoverySpec;
  /** How text reaches the TV (decides live typing vs. "Enviar"). */
  readonly textMode: TextMode;
  /** False when the TV has no Enter / submit command the phone can send. */
  readonly canSubmit?: boolean;
  /** True when the connector reports the TV's keyboard open/closed (onKeyboard); typing waits for it. */
  readonly reportsKeyboard?: boolean;
  /** True when the connector can search inside apps with links (Android TV). */
  readonly appLinks?: boolean;
  /** Wait this long after connecting before sending text (Android TV switches keyboards first). */
  readonly warmUpMs?: number;
  /** Fill in details right before connecting (e.g. read the TV's API version). Optional. */
  refine?(tv: TvInfo, ctx: DriverContext): Promise<TvInfo>;
  /**
   * Connects with saved credentials. Throws PairingRequired when the TV needs pairing with a code
   * (call startPairing). For TVs that ask "allow?" on screen, connect waits for the answer
   * (telling the screen through events.onPrompt) and returns credentials to save in `saved`.
   */
  connect(tv: TvInfo, credentials: Credentials | null, events: SessionEvents, ctx: DriverContext): Promise<{ session: TvSession; saved?: Credentials }>;
  /** Code-based pairing. Only for connectors whose connect can throw PairingRequired. */
  startPairing?(tv: TvInfo, ctx: DriverContext): Promise<PairingFlow>;
}

/** For `insert` TVs: what to delete from the end and what to type, by code points. */
export function diffText(before: string, after: string): { deletes: number; insert: string } {
  const a = Array.from(before);
  const b = Array.from(after);
  let same = 0;
  while (same < a.length && same < b.length && a[same] === b[same]) same++;
  return { deletes: a.length - same, insert: b.slice(same).join('') };
}

/** Parses the headers of an SSDP reply / NOTIFY ("NAME: value" lines, names lower-cased). */
export function ssdpHeaders(response: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of response.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}

/** Text content of the first <tag>…</tag> in an XML string (namespace prefixes ignored). */
export function xmlTag(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'i').exec(xml);
  return m ? decodeXml(m[1].trim()) : undefined;
}

export function decodeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
