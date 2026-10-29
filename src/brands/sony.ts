// Sony BRAVIA (non-Android 2013-2015, and as a fallback on Android/Google TV sets that are
// better driven over the Android TV Remote): the Scalar Web API, HTTP JSON-RPC on port 80
// (HTTPS 443 on 2025 firmware). Text: appControl.setTextForm (whole field) while the TV's
// software keyboard is up (getApplicationStatusList reports it). Enter: the IRCC "Confirm" key.
// Pairing: actRegister shows a 4-digit PIN and returns an auth cookie to reuse.
// Sources: Sony BRAVIA Pro REST API, Drafteed/pybravia, Home Assistant braviatv, openHAB.

import { base64Encode, utf8Encode } from '../protocol/bytes';
import { httpRequest, type HttpResponse } from '../net/http';
import type { SsdpReply, Transport } from '../protocol/transport';
import {
  escapeXml,
  PairingError,
  PairingRequired,
  xmlTag,
  type Credentials,
  type Driver,
  type DriverContext,
  type NavKey,
  type PairingFlow,
  type SessionEvents,
  type TvInfo,
  type TvSession,
} from './types';

const SONY_UPNP_PORT = 52323;
const IRCC_SERVICE = 'urn:schemas-sony-com:service:IRCC:1';
// IRCC codes (base64), from Sony's getRemoteControllerInfo lists.
const IRCC = {
  confirm: 'AAAAAQAAAAEAAABlAw==',
  up: 'AAAAAQAAAAEAAAB0Aw==',
  down: 'AAAAAQAAAAEAAAB1Aw==',
  left: 'AAAAAQAAAAEAAAA0Aw==',
  right: 'AAAAAQAAAAEAAAAzAw==',
  back: 'AAAAAgAAAJcAAAAjAw==',
  home: 'AAAAAQAAAAEAAABgAw==',
};
const NAV_IRCC: Record<NavKey, string> = {
  enter: IRCC.confirm,
  up: IRCC.up,
  down: IRCC.down,
  left: IRCC.left,
  right: IRCC.right,
  back: IRCC.back,
  home: IRCC.home,
};

type Auth = { psk?: string; cookie?: string };

function headers(auth: Auth, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json; charset=UTF-8', ...extra };
  if (auth.psk) h['X-Auth-PSK'] = auth.psk;
  if (auth.cookie) h.Cookie = `auth=${auth.cookie}`;
  return h;
}

type RpcResult = { result?: unknown[]; results?: unknown[]; error?: [number, string] };

function scheme(tv: TvInfo): 'http' | 'https' {
  return tv.hints?.https === 'yes' ? 'https' : 'http';
}

/** One Scalar Web API call. Throws on auth failure (so the controller can pair), returns result[] otherwise. */
async function rpc(
  transport: Transport,
  tv: TvInfo,
  service: string,
  method: string,
  params: unknown[],
  auth: Auth,
  version = '1.0',
): Promise<unknown[]> {
  const response: HttpResponse = await httpRequest(transport, {
    method: 'POST',
    url: `${scheme(tv)}://${tv.host}/sony/${service}`,
    headers: headers(auth),
    body: JSON.stringify({ method, id: 2, params, version }),
    timeoutMs: 5000,
  });
  if (response.status === 401 || response.status === 403) throw new PairingRequired();
  const json = response.json<RpcResult>();
  if (json.error) {
    const [code, message] = json.error;
    if (code === 401 || code === 403) throw new PairingRequired();
    throw new SonyError(message || `error ${code}`, code);
  }
  return json.result ?? json.results ?? [];
}

class SonyError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

/** GET dmr.xml on the UPnP port; null if it isn't a Sony TV with the web API. */
async function describe(transport: Transport, host: string): Promise<TvInfo | null> {
  let response;
  try {
    response = await httpRequest(transport, { url: `http://${host}:${SONY_UPNP_PORT}/dmr.xml`, timeoutMs: 2500 });
  } catch {
    return null;
  }
  const xml = response.text();
  if (response.status !== 200 || !/Sony/i.test(xmlTag(xml, 'manufacturer') ?? '')) return null;
  // A TV advertises the videoScreen service; soundbars and receivers don't.
  if (!/videoScreen/.test(xml) && !/ScalarWebAPI/.test(xml)) return null;
  const udn = xmlTag(xml, 'UDN');
  return {
    brand: 'sony',
    host,
    name: (xmlTag(xml, 'friendlyName') ?? 'Sony BRAVIA').replace(/^BRAVIA\s+/, 'Sony '),
    id: udn ? udn.replace(/^uuid:/i, '').toLowerCase() : undefined,
    model: xmlTag(xml, 'modelName'),
  };
}

/** One stable client id per phone, so the TV recognises us on reconnect and renewal. */
function clientId(ctx: DriverContext): string {
  const store = ctx as unknown as { clientId?: string };
  return store.clientId ?? (store.clientId = `TecladoTV:${randomUuid(ctx)}`);
}

/** The PIN this run's client id was registered with on each TV, for a re-pair the TV answers without one. */
function runPins(ctx: DriverContext): Record<string, string> {
  const store = ctx as unknown as { sonyPins?: Record<string, string> };
  return (store.sonyPins ??= {});
}

function randomUuid(ctx: DriverContext): string {
  const b = ctx.transport.randomBytes?.(16) ?? Uint8Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function authFrom(credentials: Credentials | null): Auth {
  return { psk: credentials?.psk || undefined, cookie: credentials?.cookie || undefined };
}

/** accessControl.actRegister for `clientid`, with Basic ":pin" when given. Never sends a cookie. */
function actRegister(transport: Transport, tv: TvInfo, clientid: string, pin: string | undefined, timeoutMs: number): Promise<HttpResponse> {
  const h: Record<string, string> = { 'Content-Type': 'application/json; charset=UTF-8' };
  if (pin !== undefined) h.Authorization = `Basic ${base64Encode(utf8Encode(`:${pin}`))}`;
  return httpRequest(transport, {
    method: 'POST',
    url: `${scheme(tv)}://${tv.host}/sony/accessControl`,
    headers: h,
    body: JSON.stringify({
      method: 'actRegister',
      id: 1,
      version: '1.0',
      params: [{ clientid, nickname: 'Teclado TV', level: 'private' }, [{ value: 'yes', function: 'WOL' }]],
    }),
    timeoutMs,
  });
}

/** Pull the auth=... token from a Set-Cookie header. */
function cookieFrom(response: HttpResponse): string | undefined {
  const raw = response.headers['set-cookie'];
  return raw ? /auth=([^;]+)/.exec(raw)?.[1] : undefined;
}

class SonySession implements TvSession {
  readonly textMode = 'replace' as const;
  ready = true;
  closed = false;
  private poll: ReturnType<typeof setInterval> | null = null;
  private keyboardOn = false;
  private queue: Promise<unknown> = Promise.resolve();
  /** Consecutive failed polls, and an in-flight guard so a slow/dead TV can't stack sockets. */
  private failures = 0;
  private polling = false;
  private irccPath = 'ircc';
  private lastIrccAt = 0;

  constructor(
    private transport: Transport,
    private tv: TvInfo,
    private auth: Auth,
    private events: SessionEvents,
  ) {
    // The TV has no push channel: poll whether its software keyboard is up.
    this.checkKeyboard();
    this.poll = setInterval(() => this.checkKeyboard(), 1500);
  }

  private async checkKeyboard() {
    // Skip if a previous poll is still in flight: each rpc can take up to its 5s timeout, and the
    // interval fires every 1.5s, so without this guard a silent TV stacks overlapping sockets.
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      const result = (await rpc(this.transport, this.tv, 'appControl', 'getApplicationStatusList', [], this.auth)) as [{ name: string; status: string }[]];
      this.failures = 0;
      const on = (result[0] ?? []).some((s) => s.name === 'textInput' && s.status === 'on');
      if (on !== this.keyboardOn) {
        this.keyboardOn = on;
        this.events.onKeyboard?.({ visible: on });
      }
    } catch (e) {
      if (this.closed) return;
      if (e instanceof PairingRequired) {
        this.close();
        this.events.onClose('needs_pairing');
      } else if (++this.failures >= 3) {
        // The TV answered once but has now gone quiet (powered off / off the Wi-Fi): report the
        // loss so the controller reconnects, instead of polling a dead session forever.
        this.close();
        this.events.onClose('network');
      }
    } finally {
      this.polling = false;
    }
  }

  updateText(_before: string, after: string) {
    this.enqueue(() =>
      rpc(this.transport, this.tv, 'appControl', 'setTextForm', [after], this.auth).catch((e) => {
        // The keyboard poll is auth level "none", so a dead cookie first shows up here.
        if (e instanceof PairingRequired && !this.closed) {
          this.close();
          this.events.onClose('needs_pairing');
        }
        throw e;
      }),
    );
  }

  submit() {
    this.sendKey('enter');
  }

  sendKey(key: NavKey) {
    this.enqueue(() => this.ircc(NAV_IRCC[key]));
  }

  private async ircc(code: string) {
    const send = (c: string) =>
      httpRequest(this.transport, {
        method: 'POST',
        url: `${scheme(this.tv)}://${this.tv.host}/sony/${this.irccPath}`,
        headers: headers(this.auth, { 'Content-Type': 'text/xml; charset=UTF-8', SOAPACTION: `"${IRCC_SERVICE}#X_SendIRCC"` }),
        body:
          `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
          `<s:Body><u:X_SendIRCC xmlns:u="${IRCC_SERVICE}"><IRCCCode>${c}</IRCCCode></u:X_SendIRCC></s:Body></s:Envelope>`,
        timeoutMs: 5000,
      });
    // Some sets only answer /sony/IRCC, others only /sony/ircc (HA core#86132, #84557).
    const swap = () => (this.irccPath = this.irccPath === 'ircc' ? 'IRCC' : 'ircc');
    try {
      if (Date.now() - this.lastIrccAt > 10 * 60_000) {
        // Some sets ignore the first IRCC after ~15 min without one (python-bravia-tv#15): wake them up with an empty code.
        if ((await send('').catch(() => null))?.status === 404) swap();
      }
      this.lastIrccAt = Date.now();
      if ((await send(code)).status === 404) {
        swap();
        await send(code);
      }
    } catch {
      // network error: nothing to do
    }
    void escapeXml;
  }

  private enqueue(work: () => Promise<unknown>) {
    // Sony rejects overlapping requests (error 40003): one at a time, latest wins.
    this.queue = this.queue.then(work, work).catch(() => {});
  }

  close() {
    this.closed = true;
    this.ready = false;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }
}

export const sony: Driver = {
  brand: 'sony',
  label: 'Sony',
  priority: 45,
  textMode: 'replace',
  reportsKeyboard: true,
  discovery: {
    ssdpTargets: ['urn:schemas-sony-com:service:ScalarWebAPI:1', IRCC_SERVICE],
    probePorts: [SONY_UPNP_PORT],
    manufacturer: /sony/i,
    async fromSsdp(reply: SsdpReply, headers_, ctx) {
      if (!/sony/i.test(`${headers_.st ?? ''} ${headers_.usn ?? ''} ${headers_.server ?? ''}`) && !/ScalarWebAPI/.test(headers_.st ?? '')) return null;
      return describe(ctx.transport, reply.host);
    },
    fromPort: (host, _port, ctx) => describe(ctx.transport, host),
  },

  async refine(tv, ctx) {
    // 2025 firmware answers 403 on plain HTTP; those sets use HTTPS 443.
    try {
      const probe = await httpRequest(ctx.transport, {
        method: 'POST',
        url: `http://${tv.host}/sony/system`,
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ method: 'getInterfaceInformation', id: 1, params: [], version: '1.0' }),
        timeoutMs: 3000,
      });
      const https = probe.status === 403 && !/json/i.test(probe.headers['content-type'] ?? '') ? 'yes' : 'no';
      return https === tv.hints?.https ? tv : { ...tv, hints: { ...tv.hints, https } };
    } catch {
      return tv;
    }
  },

  async connect(tv, credentials, events, ctx) {
    const auth = authFrom(credentials);
    if (!auth.psk && !auth.cookie) throw new PairingRequired();
    let saved: Credentials | undefined;
    if (!auth.psk && credentials?.clientId && credentials.pin) {
      // The cookie lasts 14 days (Max-Age=1209600): re-register with the saved PIN on every connect,
      // as pybravia/Home Assistant do. Never send the old cookie here (an expired one gets 401).
      const r = await actRegister(ctx.transport, tv, credentials.clientId, credentials.pin, 5000);
      if (r.status === 401 || r.status === 403) throw new PairingRequired();
      const fresh = r.status === 200 ? cookieFrom(r) : undefined;
      if (fresh) saved = { cookie: (auth.cookie = fresh) };
    }
    // Confirm the TV is reachable (this method is auth level "none": a bad cookie shows up on setTextForm).
    await rpc(ctx.transport, tv, 'appControl', 'getApplicationStatusList', [], auth);
    const session = new SonySession(ctx.transport, tv, auth, events);
    return { session, saved };
  },

  async startPairing(tv, ctx): Promise<PairingFlow> {
    const id = clientId(ctx);
    // First call with no auth: a TV that doesn't know this id shows the PIN and answers 401.
    // Network errors propagate (the controller says it couldn't ask the TV for a code).
    const first = await actRegister(ctx.transport, tv, id, undefined, 8000);
    const known = first.status === 200 ? cookieFrom(first) : undefined;
    if (known) {
      // The TV already knows this id (e.g. "Volver a vincular" in the same run): no PIN, cookie now.
      // Keep the PIN this id was registered with on this TV (this run), so the 14-day cookie is still
      // renewed; '' if unknown, so a PIN saved for another client id is never reused.
      const saved = { cookie: known, clientId: id, pin: runPins(ctx)[tv.id ?? tv.host] ?? '' };
      return { prompt: { kind: 'accept', title: 'Vinculá tu celular', message: 'Conectando…' }, accepted: Promise.resolve(saved), cancel() {}, onClose() {} };
    }
    return {
      prompt: {
        kind: 'code',
        length: 4,
        charset: 'digits',
        title: 'Vinculá tu celular',
        message: `Escribí el código de 4 números que aparece en ${tv.name || 'la tele'}. Si no aparece, activá en la tele el control remoto por red (Ajustes → Red → Control remoto).`,
      },
      async submit(code): Promise<Credentials> {
        const response = await actRegister(ctx.transport, tv, id, code, 8000);
        if (response.status === 401 || response.status === 403) throw new PairingError('Ese código no coincide. Fijate en la tele.', 'bad_code');
        if (response.status !== 200) throw new PairingError('La tele no aceptó el código.', 'rejected');
        const cookie = cookieFrom(response);
        if (!cookie) throw new PairingError('La tele no dio una sesión. Probá de nuevo.', 'rejected');
        // The PIN is kept to renew the 14-day cookie (pybravia/HA re-register with it on every connect).
        runPins(ctx)[tv.id ?? tv.host] = code;
        return { cookie, clientId: id, pin: code };
      },
      cancel() {},
      onClose() {},
    };
  },
};
