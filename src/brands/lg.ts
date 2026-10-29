// LG webOS TVs (2014+): SSAP, JSON over a WebSocket (ws://host:3000 or wss://host:3001).
// Text: com.webos.service.ime insertText / deleteCharacters / sendEnterKey while a system IME field
// is focused (registerRemoteKeyboard tells us). Keys go over a second "pointer" socket.
// Pairing: the TV shows an Allow prompt and gives a client-key to reuse. 2024+ (webOS 26) rejects the
// old signed manifest, so we send the unsigned one.
// Sources: home-assistant-libs/aiowebostv, hobbyquaker/lgtv2, ConnectSDK, supersaiyanmode/PyWebOSTV.

import { utf8Decode } from '../protocol/bytes';
import type { Transport } from '../protocol/transport';
import { WebSocketClient } from '../net/websocket';
import { diffText, PairingError, type Driver, type NavKey, type SessionEvents, type TvInfo, type TvSession } from './types';

const PORTS = [
  { port: 3001, secure: true },
  { port: 3000, secure: false },
];

// Unsigned manifest: the only one that pairs on webOS 26, and enough for text + keys on older sets.
const MANIFEST = {
  manifestVersion: 1,
  appVersion: '1.1',
  permissions: [
    'LAUNCH',
    'LAUNCH_WEBAPP',
    'APP_TO_APP',
    'CONTROL_AUDIO',
    'CONTROL_INPUT_TEXT',
    'CONTROL_MOUSE_AND_KEYBOARD',
    'CONTROL_POWER',
    'CONTROL_DISPLAY',
    'CONTROL_INPUT_JOYSTICK',
    'CONTROL_INPUT_MEDIA_PLAYBACK',
    'CONTROL_INPUT_TV',
    'READ_INSTALLED_APPS',
    'READ_INPUT_DEVICE_LIST',
    'READ_NETWORK_STATE',
    'READ_RUNNING_APPS',
    'READ_TV_CHANNEL_LIST',
    'WRITE_NOTIFICATION_TOAST',
    'READ_POWER_STATE',
    'READ_CURRENT_CHANNEL',
    'SEARCH',
  ],
};

const POINTER_KEYS: Record<NavKey, string> = {
  enter: 'ENTER',
  back: 'BACK',
  up: 'UP',
  down: 'DOWN',
  left: 'LEFT',
  right: 'RIGHT',
  home: 'HOME',
};

/** A WebSocket speaking SSAP: request/response by id, plus subscriptions. */
/** Heartbeat timing (tests shorten it). */
export const lgKeepAlive = { everyMs: 10_000, maxIdleMs: 15_000 };

class SsapSocket {
  private ws: WebSocketClient;
  private nextId = 0;
  private waiting = new Map<string, { resolve: (payload: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private subs = new Map<string, (payload: Record<string, unknown>) => void>();
  onClose: (error: string | null) => void = () => {};
  /** Set during registration: sees every frame so it can tell "prompt shown" from "registered". */
  private registerListener: ((message: { type?: string; payload?: Record<string, unknown>; error?: string }) => void) | null = null;
  /** Rejects an in-flight register() when the socket closes, instead of waiting out its timer. */
  private registerReject: ((e: Error) => void) | null = null;
  private helloListener: ((payload: Record<string, unknown>) => void) | null = null;
  private aliveTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * A TV going to standby doesn't always close the socket (lgtv2's README), so ping it like lgtv2 and
   * aiowebostv do, and drop the socket when nothing (not even a pong) came back for a while.
   */
  keepAlive() {
    if (this.aliveTimer) return;
    this.aliveTimer = setInterval(() => {
      if (Date.now() - this.ws.lastReceivedAt > lgKeepAlive.maxIdleMs) this.ws.close();
      else this.ws.ping();
    }, lgKeepAlive.everyMs);
  }

  constructor(ws: WebSocketClient) {
    this.ws = ws;
    ws.setHandlers(
      (raw) => this.onMessage(raw),
      (error) => this.handleClose(error),
    );
  }

  /** The socket closed: fail everything in flight so callers don't sit on their own timeouts. */
  private handleClose(error: string | null) {
    if (this.aliveTimer) clearInterval(this.aliveTimer);
    this.aliveTimer = null;
    for (const waiter of this.waiting.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(error ?? 'La tele cerró la conexión'));
    }
    this.waiting.clear();
    this.registerReject?.(new PairingError(error ?? 'La tele cerró la conexión', 'closed'));
    this.onClose(error);
  }

  private onMessage(raw: string | Uint8Array) {
    let message: { id?: string; type?: string; payload?: Record<string, unknown>; error?: string };
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : utf8Decode(raw));
    } catch {
      return;
    }
    const id = message.id ?? '';
    if (message.type === 'hello' && this.helloListener) {
      const listener = this.helloListener;
      this.helloListener = null;
      listener(message.payload ?? {});
      return;
    }
    if (id === 'register_0' && this.registerListener) {
      this.registerListener(message);
      return;
    }
    const sub = this.subs.get(id);
    if (sub && message.type !== 'error') sub(message.payload ?? {});
    const waiter = this.waiting.get(id);
    if (!waiter) return;
    this.waiting.delete(id);
    clearTimeout(waiter.timer);
    if (message.type === 'error' || message.payload?.returnValue === false) {
      waiter.reject(new SsapError(message.error || 'request failed', message.payload ?? {}));
    } else {
      waiter.resolve(message.payload ?? {});
    }
  }

  send(obj: Record<string, unknown>) {
    this.ws.send(JSON.stringify(obj));
  }

  request(uri: string, payload: Record<string, unknown> = {}, timeoutMs = 6000): Promise<Record<string, unknown>> {
    const id = `req_${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`timeout: ${uri}`));
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      this.send({ id, type: 'request', uri, payload });
    });
  }

  /** Fire-and-forget request (IME calls where we don't need the ack). */
  fire(uri: string, payload: Record<string, unknown> = {}) {
    this.send({ id: `cmd_${this.nextId++}`, type: 'request', uri, payload });
  }

  subscribe(uri: string, onUpdate: (payload: Record<string, unknown>) => void) {
    const id = `sub_${this.nextId++}`;
    this.subs.set(id, onUpdate);
    this.send({ id, type: 'subscribe', uri, payload: {} });
  }

  hello() {
    this.send({ id: 'hello', type: 'hello', payload: {} });
  }

  /** Sends hello and resolves with its payload (deviceUUID, OS version…), or {} on timeout. */
  helloInfo(timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.helloListener = null;
        resolve({});
      }, timeoutMs);
      this.helloListener = (payload) => {
        clearTimeout(timer);
        resolve(payload);
      };
      this.hello();
    });
  }

  /**
   * Sends register and resolves with the client-key once the TV answers "registered".
   * The intermediate "response" (prompt shown on the TV) calls onPrompt, not resolve.
   */
  register(payload: Record<string, unknown>, onPrompt: () => void, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.clearRegister();
        reject(new PairingError('No hubo respuesta en la tele', 'timeout'));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        this.clearRegister();
      };
      // handleClose uses this to fail pairing the moment the TV drops the socket.
      this.registerReject = (e) => {
        done();
        reject(e);
      };
      this.registerListener = (message) => {
        if (message.type === 'registered') {
          const key = (message.payload?.['client-key'] as string) || '';
          if (key) {
            done();
            resolve(key);
          }
        } else if (message.type === 'response' && (message.payload?.pairingType || message.payload?.returnValue)) {
          onPrompt();
        } else if (message.type === 'error') {
          done();
          reject(new SsapError(message.error || 'register failed', message.payload ?? {}));
        }
      };
      this.send({ id: 'register_0', type: 'register', payload });
    });
  }

  private clearRegister() {
    this.registerListener = null;
    this.registerReject = null;
  }

  close() {
    this.ws.close();
  }
}

class SsapError extends Error {
  constructor(
    message: string,
    readonly payload: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function openSocket(transport: Transport, host: string, preferSecure: boolean): Promise<{ socket: SsapSocket; secure: boolean }> {
  const order = preferSecure ? PORTS : [...PORTS].reverse();
  let lastError: unknown;
  for (const { port, secure } of order) {
    try {
      // LG rejects a browser Origin header; our WebSocket client sends none.
      const ws = await WebSocketClient.connect(transport, `${secure ? 'wss' : 'ws'}://${host}:${port}`, { timeoutMs: 5000 });
      return { socket: new SsapSocket(ws), secure };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error('no webOS port');
}

class LgSession implements TvSession {
  readonly textMode = 'insert' as const;
  ready = true;
  closed = false;
  private pointer: WebSocketClient | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private socket: SsapSocket,
    private events: SessionEvents,
  ) {
    socket.subscribe('ssap://com.webos.service.ime/registerRemoteKeyboard', (payload) => {
      const widget = payload.currentWidget as { focus?: boolean } | undefined;
      if (widget) this.events.onKeyboard?.({ visible: widget.focus === true });
    });
  }

  async connectPointer() {
    try {
      const payload = await this.socket.request('ssap://com.webos.service.networkinput/getPointerInputSocket');
      const path = payload.socketPath as string;
      if (path) this.pointer = await WebSocketClient.connect(this.pointerTransport, path, { timeoutMs: 4000 });
    } catch {
      // keys are optional; typing still works without the pointer socket
    }
  }

  /** Set by the driver so the pointer socket uses the same transport. */
  pointerTransport!: Transport;

  updateText(before: string, after: string) {
    const { deletes, insert } = diffText(before, after);
    // Serialise IME calls; LG wants one in flight at a time.
    this.enqueue(async () => {
      if (deletes > 0) this.socket.fire('ssap://com.webos.service.ime/deleteCharacters', { count: deletes });
      if (insert) this.socket.fire('ssap://com.webos.service.ime/insertText', { text: insert, replace: false });
    });
  }

  submit() {
    this.enqueue(async () => this.socket.fire('ssap://com.webos.service.ime/sendEnterKey', {}));
  }

  sendKey(key: NavKey) {
    if (this.pointer && !this.closed) this.pointer.send(`type:button\nname:${POINTER_KEYS[key]}\n\n`);
  }

  private enqueue(work: () => Promise<void>) {
    this.queue = this.queue.then(work, work);
  }

  close() {
    this.closed = true;
    this.ready = false;
    this.pointer?.close();
    this.socket.close();
  }
}

/** webOS has no standard mDNS/SSDP name field we trust; read system info over the socket. */
async function probeWebos(transport: Transport, host: string): Promise<TvInfo | null> {
  let opened;
  try {
    opened = await openSocket(transport, host, true);
  } catch {
    return null;
  }
  try {
    const hello = await opened.socket.helloInfo(2500);
    let name = 'LG TV';
    let model: string | undefined;
    try {
      const info = await opened.socket.request('ssap://system/getSystemInfo', {}, 2500);
      model = (info.modelName as string) || undefined;
    } catch {
      // needs registration on newer firmware; the name comes later
    }
    const uuid = (hello.deviceUUID as string) || undefined;
    return { brand: 'lg', host, name, model, id: uuid, hints: { secure: opened.secure ? 'yes' : 'no' } };
  } finally {
    opened.socket.close();
  }
}

export const lg: Driver = {
  brand: 'lg',
  label: 'LG',
  priority: 55,
  textMode: 'insert',
  reportsKeyboard: true,
  discovery: {
    ssdpTargets: ['urn:lge-com:service:webos-second-screen:1'],
    probePorts: [3001, 3000],
    manufacturer: /lg electronics|webos/i,
    async fromSsdp(reply, headers, ctx) {
      const text = `${headers.st ?? ''} ${headers.usn ?? ''} ${headers.server ?? ''} ${headers.location ?? ''}`;
      if (!/lge?[-_ ]?com|webos|lg ?electronics/i.test(text)) return null;
      return probeWebos(ctx.transport, reply.host);
    },
    fromPort: (host, _port, ctx) => probeWebos(ctx.transport, host),
  },

  // LG pairs during connect: with a stored client-key the TV registers at once; without one
  // (or if it was revoked) it shows an Allow prompt, which we surface through events.onPrompt,
  // then it hands back a key to persist.
  async connect(tv, credentials, events, ctx) {
    const preferSecure = tv.hints?.secure !== 'no';
    const { socket, secure } = await openSocket(ctx.transport, tv.host, preferSecure);
    const clientKey = credentials?.clientKey ?? null;
    socket.hello();
    const payload: Record<string, unknown> = { forcePairing: false, pairingType: 'PROMPT', manifest: MANIFEST };
    if (clientKey) payload['client-key'] = clientKey;
    let key: string;
    try {
      key = await socket.register(
        payload,
        () =>
          events.onPrompt?.({
            kind: 'accept',
            title: 'Permití el celular en la tele',
            message: `${tv.name || 'La tele'} va a preguntar si permitís este celular. Elegí «Permitir» (Sí) con el control. Se hace una sola vez.`,
          }),
        60_000,
      );
    } catch (e) {
      socket.close();
      if (e instanceof PairingError) throw e;
      throw e instanceof SsapError ? new PairingError('La tele no dio permiso', 'rejected') : e;
    }
    const session = new LgSession(socket, events);
    session.pointerTransport = ctx.transport;
    socket.onClose = (error) => {
      if (!session.closed) {
        session.close(); // also closes the pointer socket, which would otherwise outlive the session
        events.onClose('network', error);
      }
    };
    socket.keepAlive();
    await session.connectPointer();
    const saved = key !== clientKey ? { clientKey: key, secure: secure ? 'yes' : 'no' } : undefined;
    return { session, saved };
  },
};
