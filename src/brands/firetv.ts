// Amazon Fire TV (Fire OS sticks and Cube): the local service the official Fire TV app talks to,
// HTTPS on port 8080 with a self-signed certificate, woken through DIAL on port 8009. Pairing
// shows a 4-digit PIN on the TV and returns a client token. Text goes as one whole string in
// POST /v1/FireTV/keyboard, only while GET /v1/FireTV/keyboard says a text field is open.
// Nobody knows whether that POST appends to the field or replaces it, and no source has a delete
// or an Enter for the keyboard, so the phone box is a draft sent as a whole ("Enviar"), like
// Panasonic, and there's no Enter button.
//
// Seen working on real hardware by one maintainer only: a Fire TV Stick 4K Plus (AFTMA08C15,
// Fire OS 8, remote service 0.1.147068) typed the ASCII strings "LibreControl cafe" and "Matrix"
// (LC hardware-validation.md, 2026-10-19). Not tested here on a real device: accents, deleting and
// Fire TV Edition TVs are unconfirmed. The service answers 200 even when the text doesn't land
// (LC: the old /v1/FireTV/text route "returned 200 without visible input"), so the keyboard check
// before sending is the only guard.
//
// Sources (read 2026-11-04; every endpoint, header and payload below cites one of them):
// - [LC] github.com/LibreControl/fire-tv @93f874e: docs/protocol.md, docs/hardware-validation.md,
//   src/FireTvDevice.ts, src/transport/http.ts, src/discovery/ssdp.ts.
// - [ZP] github.com/zane-programs/reversing-with-claude-code @bc74c5e: fire-tv/PROTOCOL.md.
// - [C4] github.com/zane-programs/C4-FireTV-RE @841e64f: README.md, firetv.lua.
// - [HA] community.home-assistant.io/t/rest-commands-for-fire-tv/901314 (post number given).
// - [UC] github.com/mase1981/uc-intg-firetv @e3ca17e: intg_firetv/client.py.

import { httpRequest, type HttpResponse } from '../net/http';
import { parseUrl } from '../net/url';
import { TransportError, type MdnsService, type SsdpReply, type Transport } from '../protocol/transport';
import {
  PairingError,
  PairingRequired,
  ssdpHeaders,
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

/** The remote API. [ZP] "Port 8080: Fire TV Remote API"; HTTPS per [C4] README ("Port 8080 (HTTPS)") and [HA] post 1. */
export const FIRETV_PORT = 8080;
/** [ZP] "Port 8009: DIAL"; [HA] post 3 `curl -X POST http://…:8009/apps/FireTVRemote`. */
export const FIRETV_DIAL_PORT = 8009;
/** [ZP] Discovery: `_amzn-fireTv._tcp.local.`. The confirmed stick did not announce it ([LC] hardware-validation.md). */
export const FIRETV_MDNS = '_amzn-fireTv._tcp';
/** [LC] protocol.md Discovery: SSDP `ST: urn:dial-multiscreen-org:service:dial:1`, confirmed on the stick (2026-10-19). */
export const DIAL_ST = 'urn:dial-multiscreen-org:service:dial:1';

/** [ZP] Required Headers: `x-api-key: 0987654321`, "a static, hardcoded value"; same in [LC] protocol.md and [HA] post 1. */
const API_KEY = '0987654321';
/** The official app's client, as captured in [HA] post 25 (`User-Agent: okhttp/4.10.0`) and sent in [HA] post 1. */
const USER_AGENT = 'okhttp/4.10.0';
/** [LC] src/FireTvDevice.ts inputText: the states that count as a text field being open. */
const KEYBOARD_OPEN = ['visible', 'text', 'active', 'shown'];
/** [LC] src/FireTvDevice.ts heldActions: D-pad and Select go as keyDown + keyUp. */
const PRESS_ACTIONS: Partial<Record<NavKey, string>> = {
  up: 'dpad_up',
  down: 'dpad_down',
  left: 'dpad_left',
  right: 'dpad_right',
  enter: 'select',
};
/** [ZP] "For Home, Back, Menu (simple press)": empty body. */
const SIMPLE_ACTIONS: Partial<Record<NavKey, string>> = { back: 'back', home: 'home' };

const POLL_MS = 2000;
/** A draft waiting for the TV to open a text field is dropped after this long. */
const PENDING_MAX_MS = 60_000;
/** [C4] firetv.lua `DEFAULT_WAKE_WAIT = 2000` ("Wait after wake before retry"). */
const WAKE_WAIT_MS = 2000;

const isIpv4 = (text: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(text);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FireTvApi {
  constructor(
    private transport: Transport,
    readonly host: string,
    private port: number,
    private token?: string,
  ) {}

  /**
   * Starts the TV's remote service: [ZP] DIAL `POST /apps/FireTVRemote`, `Content-Type: text/plain`,
   * empty body, "Response: 201 Created". Headers as the official app sends them ([HA] post 25:
   * `Content-Length: 0`, `Content-Type: text/plain; charset=utf-8`, `User-Agent: okhttp/4.10.0`).
   * Without it 8080 can refuse connections ([HA] post 3: "the app hasn't started so isn't listening
   * on 8080"; post 29: "it needs to wake up each time it has sat for a good while"). A failed wake
   * isn't an error by itself ([UC] wake_up: "device may already be awake"); the next request tells.
   */
  async wake(): Promise<boolean> {
    try {
      const response = await httpRequest(this.transport, {
        method: 'POST',
        url: `http://${this.host}:${FIRETV_DIAL_PORT}/apps/FireTVRemote`,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'User-Agent': USER_AGENT },
        body: '',
        timeoutMs: 3000,
      });
      return response.status === 201;
    } catch {
      return false;
    }
  }

  /**
   * One request to the remote API. [ZP]/[LC]: every request carries
   * `Content-Type: application/json; charset=utf-8` and `x-api-key`; authenticated ones add
   * `x-client-token`. If the connection fails (the service went to sleep) and DIAL answers, wakes
   * it and tries once more: nothing reached the TV, so retrying can't repeat a command.
   */
  async call(method: 'GET' | 'POST', path: string, body?: unknown, authenticated = true, rewake = true): Promise<HttpResponse> {
    const send = () =>
      httpRequest(this.transport, {
        method,
        url: `https://${this.host}:${this.port}${path}`,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'x-api-key': API_KEY,
          'User-Agent': USER_AGENT,
          ...(authenticated && this.token ? { 'x-client-token': this.token } : {}),
        },
        // [LC] src/transport/http.ts: POSTs always have a body (JSON, or empty).
        body: method === 'POST' ? (body === undefined ? '' : JSON.stringify(body)) : undefined,
        timeoutMs: 5000,
      });
    try {
      return await send();
    } catch (e) {
      if (!rewake || !(e instanceof TransportError) || !(await this.wake())) throw e;
      await sleep(WAKE_WAIT_MS);
      return send();
    }
  }

  /**
   * Wakes the service, then makes the first request. After a 201 the service takes a moment to
   * listen ([C4] waits 2 s after waking), so a refused connection is retried for ~2 s. If DIAL
   * didn't answer either, the TV isn't there: no retries (the TV may be off).
   */
  async callAfterWake(method: 'GET' | 'POST', path: string, body?: unknown, authenticated = true): Promise<HttpResponse> {
    const woke = await this.wake();
    for (let tries = 0; ; tries++) {
      try {
        return await this.call(method, path, body, authenticated, false);
      } catch (e) {
        if (!woke || !(e instanceof TransportError) || tries >= 3) throw e;
        await sleep(700);
      }
    }
  }
}

/** [ZP] Error Handling: "401 Unauthorized - Invalid/missing client token"; [LC] hardware-validation.md: the stick answered 403. */
const unauthorized = (response: HttpResponse) => response.status === 401 || response.status === 403;
const ok = (response: HttpResponse) => response.status >= 200 && response.status < 300;

function json(response: HttpResponse): Record<string, unknown> | null {
  try {
    const value = response.json<unknown>();
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** [LC] src/FireTvDevice.ts tokenValid: a non-empty printable ASCII string. */
const validToken = (token: unknown): token is string => typeof token === 'string' && /^[\x20-\x7e]+$/.test(token);

/**
 * [ZP] GET /v1/FireTV/keyboard: `{"mode": null, "state": "hidden", "text": null}`. [LC] on the
 * stick: `hidden`/null with no field, `visible`/`keyboard` with a field open, `text`/`keyboard`
 * after typing. The `text` field isn't used: no source shows what it holds on real hardware, and
 * putting it in the draft would send it twice if the TV appends.
 */
function keyboardOpen(response: HttpResponse): boolean | null {
  const value = json(response);
  if (!value || typeof value.state !== 'string') return null;
  return KEYBOARD_OPEN.includes(value.state.toLowerCase());
}

class FireTvSession implements TvSession {
  readonly textMode = 'append' as const;
  ready = true;
  closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private poll: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private failures = 0;
  private keyboard: boolean | null = null;
  /** Text the user sent while no field was open on the TV: it goes in once one opens. */
  private pending = '';
  private pendingAt = 0;

  constructor(
    private api: FireTvApi,
    private events: SessionEvents,
  ) {
    // The TV has no push channel: ask whether a text field is open.
    this.checkKeyboard();
    this.poll = setInterval(() => this.checkKeyboard(), POLL_MS);
  }

  updateText(before: string, after: string) {
    // Append-only: nothing can be deleted from the phone (no source has a delete).
    if (this.closed || !after.startsWith(before) || after === before) return;
    this.pending += after.slice(before.length);
    this.pendingAt = Date.now();
    this.enqueue(() => this.flush());
  }

  submit() {
    // No source has an Enter for the keyboard. `select` is the OK button ([ZP]): with the TV's
    // keyboard up it would press whichever key is highlighted, so it's not sent here.
  }

  sendKey(key: NavKey) {
    const press = PRESS_ACTIONS[key];
    const simple = SIMPLE_ACTIONS[key];
    this.enqueue(async () => {
      if (this.closed) return;
      if (press) {
        // [ZP] `POST /v1/FireTV?action=dpad_up` with `{"keyActionType":"keyDown"}`, then keyUp ([LC]: "down followed by up").
        const path = `/v1/FireTV?action=${press}`;
        await this.command('POST', path, { keyActionType: 'keyDown' });
        await this.command('POST', path, { keyActionType: 'keyUp' });
      } else if (simple) {
        await this.command('POST', `/v1/FireTV?action=${simple}`);
      }
    });
  }

  /** Sends the waiting draft if a text field is open; otherwise keeps it for when one opens. */
  private async flush() {
    if (this.closed || !this.pending) return;
    // [LC] protocol.md 8: the keyboard check and the write go together, "only after an active keyboard check".
    if (await this.readKeyboard()) await this.sendPending();
  }

  private async sendPending() {
    if (this.closed || !this.pending) return;
    if (Date.now() - this.pendingAt > PENDING_MAX_MS) {
      this.pending = '';
      return;
    }
    const text = this.pending;
    this.pending = '';
    // [LC] protocol.md 8 and [HA] post 1: `POST /v1/FireTV/keyboard` with `{"text": …}`, the whole
    // string in one request ("the client does not split characters").
    const sent = await this.command('POST', '/v1/FireTV/keyboard', { text }, true);
    if (sent === undefined && !this.closed) this.pending = text + this.pending;
  }

  /** Asks the TV whether a text field is open, and tells the controller when that changes. */
  private async readKeyboard(): Promise<boolean> {
    const response = await this.command('GET', '/v1/FireTV/keyboard');
    const open = response ? keyboardOpen(response) : null;
    if (open !== null && !this.closed) this.setKeyboard(open);
    return !!open;
  }

  private checkKeyboard() {
    // Skip while a check is queued or running: each one is a new TLS connection to a small device.
    if (this.closed || this.polling) return;
    this.polling = true;
    this.enqueue(async () => {
      try {
        if (!this.closed && (await this.readKeyboard())) await this.sendPending();
      } finally {
        this.polling = false;
      }
    });
  }

  private setKeyboard(open: boolean) {
    if (open === this.keyboard) return;
    this.keyboard = open;
    this.events.onKeyboard?.({ visible: open });
  }

  /**
   * Runs one request. Returns the response, null when the TV answered with an error status, or
   * undefined when the connection failed before reaching the TV (with `undeliveredOk`, so the text
   * can be kept). 401/403 end the session as unpaired; three network failures in a row as lost.
   */
  private async command(method: 'GET' | 'POST', path: string, body?: unknown, undeliveredOk = false): Promise<HttpResponse | null | undefined> {
    try {
      const response = await this.api.call(method, path, body);
      this.failures = 0;
      if (unauthorized(response)) {
        this.end('needs_pairing');
        return null;
      }
      if (!ok(response)) this.events.onDebug?.(`firetv: ${method} ${path} -> ${response.status}`);
      return ok(response) ? response : null;
    } catch (e) {
      this.events.onDebug?.(`firetv: ${method} ${path}: ${String(e)}`);
      if (++this.failures >= 3) this.end('network');
      return undeliveredOk && e instanceof TransportError ? undefined : null;
    }
  }

  private end(reason: 'needs_pairing' | 'network') {
    if (this.closed) return;
    this.close();
    this.events.onClose(reason);
  }

  private enqueue(work: () => Promise<unknown>) {
    // [LC] protocol.md Lifecycle: "Authenticated commands serialize".
    this.queue = this.queue.then(work, work).catch(() => {});
  }

  close() {
    this.closed = true;
    this.ready = false;
    this.pending = '';
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }
}

const portOf = (tv: TvInfo) => Number(tv.hints?.port) || FIRETV_PORT;

/**
 * Reads a DIAL device description and keeps it only if it's a Fire TV. [LC] protocol.md and
 * src/discovery/ssdp.ts: fetch only numeric http URLs on the address that answered, no credentials;
 * accept manufacturer "Amazon" and a model name starting with "AFT"; the UDN UUID is the identity;
 * the remote port is 8080, not the description's port. 1.5 s per request, as there.
 */
async function describe(transport: Transport, host: string, location: string): Promise<TvInfo | null> {
  let url;
  try {
    url = parseUrl(location);
  } catch {
    return null;
  }
  if (url.scheme !== 'http' || url.host !== host || !isIpv4(host) || /@/.test(location.split('/')[2] ?? '')) return null;
  let response;
  try {
    response = await httpRequest(transport, { url: location, timeoutMs: 1500, headers: { Accept: 'application/xml, text/xml' } });
  } catch {
    return null;
  }
  if (response.status !== 200) return null;
  const xml = response.text();
  const model = xmlTag(xml, 'modelName') ?? '';
  if ((xmlTag(xml, 'manufacturer') ?? '').toLowerCase() !== 'amazon' || !/^AFT/.test(model)) return null;
  const uuid = /^uuid:([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i.exec(xmlTag(xml, 'UDN') ?? '');
  return { brand: 'firetv', host, name: xmlTag(xml, 'friendlyName') || 'Fire TV', id: uuid?.[1].toLowerCase(), model };
}

/** A DIAL search reply ([LC] ssdp.ts parseLocation: status 200, `ST` the DIAL service, a LOCATION). */
function dialLocation(reply: SsdpReply, headers: Record<string, string>): string | null {
  if (!/^HTTP\/1\.[01] 200/i.test(reply.response)) return null;
  if ((headers.st ?? '').toLowerCase() !== DIAL_ST || !headers.location) return null;
  return headers.location;
}

export const fireTv: Driver = {
  brand: 'firetv',
  label: 'Fire TV',
  priority: 35,
  textMode: 'append',
  canSubmit: false,
  reportsKeyboard: true,
  discovery: {
    mdnsTypes: [FIRETV_MDNS],
    ssdpTargets: [DIAL_ST],
    // DIAL answers on 8009 even while the remote service sleeps ([HA] post 16: "Remote wake command
    // on HTTP still works fine"). Google Cast devices use 8009 too, so an open port is only a hint:
    // fromPort confirms with the DIAL description.
    probePorts: [FIRETV_DIAL_PORT],
    fromMdns(service: MdnsService) {
      if (service.type.replace(/\.$/, '').toLowerCase() !== FIRETV_MDNS.toLowerCase()) return null;
      // [LC] protocol.md: "SRV supplies the remote port".
      const port = service.port && service.port !== FIRETV_PORT ? { port: String(service.port) } : undefined;
      return { brand: 'firetv', host: service.host, name: service.name || 'Fire TV', ...(port ? { hints: port } : {}) };
    },
    async fromSsdp(reply, headers, ctx) {
      const location = dialLocation(reply, headers);
      return location ? describe(ctx.transport, reply.host, location) : null;
    },
    async fromPort(host, _port, ctx) {
      // Ask that address alone for its DIAL description (unicast M-SEARCH). Not confirmed on a Fire
      // TV: the stick was found by the multicast search ([LC] hardware-validation.md, 2026-10-19).
      if (!ctx.transport.ssdp) return null;
      const replies = await ctx.transport.ssdp([DIAL_ST], [host], 1500).catch(() => [] as SsdpReply[]);
      for (const reply of replies) {
        if (reply.host !== host) continue;
        const location = dialLocation(reply, ssdpHeaders(reply.response));
        const tv = location ? await describe(ctx.transport, host, location) : null;
        if (tv) return tv;
      }
      return null;
    },
  },

  async connect(tv, credentials, events, ctx) {
    const token = credentials?.token;
    if (!token) throw new PairingRequired();
    const api = new FireTvApi(ctx.transport, tv.host, portOf(tv), token);
    // [LC] FireTvDevice.connect: `GET /v1/FireTV/status` checks the token; the reply has string
    // `osVersion`, `platformType`, `turnstileVersion` ([ZP] example).
    const response = await api.callAfterWake('GET', '/v1/FireTV/status');
    if (unauthorized(response)) throw new PairingRequired();
    const status = json(response);
    if (!ok(response) || typeof status?.osVersion !== 'string' || typeof status.platformType !== 'string') {
      throw new Error(`El Fire TV respondió ${response.status}`);
    }
    events.onDebug?.(`firetv: ${status.platformType} ${status.osVersion} ${String(status.turnstileVersion ?? '')}`);
    return { session: new FireTvSession(api, events) };
  },

  async startPairing(tv, ctx: DriverContext): Promise<PairingFlow> {
    const api = new FireTvApi(ctx.transport, tv.host, portOf(tv));
    // [ZP] Step 1: `POST /v1/FireTV/pin/display` with `{"friendlyName":"<client-name>"}`, answers
    // `{"description":"OK"}`. [HA] post 1: "You may need to wake it up before requesting the pin".
    const shown = await api.callAfterWake('POST', '/v1/FireTV/pin/display', { friendlyName: ctx.clientName }, false);
    if (!ok(shown) || json(shown)?.description !== 'OK') throw new Error(`El Fire TV no mostró un código (${shown.status})`);
    let cancelled = false;
    return {
      prompt: {
        kind: 'code',
        length: 4,
        charset: 'digits',
        title: 'Vinculá tu celular',
        message: `Escribí el código de 4 números que aparece en ${tv.name || 'el Fire TV'}.`,
      },
      async submit(code): Promise<Credentials> {
        if (cancelled) throw new PairingError('Se canceló la vinculación', 'closed');
        // [ZP] Step 2: `POST /v1/FireTV/pin/verify` with `{"pin":"<4-digit-pin>"}`. The token comes
        // back in `description`; an empty `description` means a wrong PIN. [LC]: a wrong PIN keeps
        // the pairing open for another try.
        const response = await api.call('POST', '/v1/FireTV/pin/verify', { pin: code }, false);
        const description = ok(response) ? json(response)?.description : undefined;
        if (description === '') throw new PairingError('Ese código no coincide. Fijate en la tele.', 'bad_code');
        if (!validToken(description)) throw new PairingError('El Fire TV no aceptó el código.', 'rejected');
        return { token: description };
      },
      cancel() {
        cancelled = true;
      },
      onClose() {},
    };
  },
};
