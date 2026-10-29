// Samsung Tizen TVs (2016+): the samsung.remote.control WebSocket.
// Text: SendInputString replaces the whole focused field while the TV's on-screen keyboard is open.
// The TV tells us the keyboard state with ms.remote.imeStart / imeUpdate / imeEnd.
// Pairing: open the socket once; the TV shows an Allow prompt and gives a token to reuse.
// Sources: xchwarze/samsung-tv-ws-api, HelgeSverre/couch-remote (2021 live tests), Home Assistant,
// openHAB, Samsung's MultiScreen SDK. See scripts/tests for a simulated TV built from these.

import { base64Decode, base64Encode, utf8Decode, utf8Encode } from '../protocol/bytes';
import type { MdnsService, Transport } from '../protocol/transport';
import { httpRequest } from '../net/http';
import { WebSocketClient } from '../net/websocket';
import {
  PairingError,
  PairingRequired,
  type Credentials,
  type Driver,
  type NavKey,
  type PairingFlow,
  type SessionEvents,
  type TvInfo,
  type TvSession,
} from './types';

const KEYS: Record<NavKey, string> = {
  enter: 'KEY_ENTER',
  back: 'KEY_RETURN',
  up: 'KEY_UP',
  down: 'KEY_DOWN',
  left: 'KEY_LEFT',
  right: 'KEY_RIGHT',
  home: 'KEY_HOME',
};

const clientParam = (name: string) => base64Encode(utf8Encode(name));
const isIpName = (name: string) => !name || /^\d+\.\d+\.\d+\.\d+$/.test(name) || name.includes(':');

function socketUrl(tv: TvInfo, name: string, token: string | null): string {
  const token_ = token ? `&token=${token}` : '';
  // Token TVs use wss://8002; 2016-2017 sets without token support use ws://8001.
  return tv.hints?.token === 'yes'
    ? `wss://${tv.host}:8002/api/v2/channels/samsung.remote.control?name=${clientParam(name)}${token_}`
    : `ws://${tv.host}:8001/api/v2/channels/samsung.remote.control?name=${clientParam(name)}`;
}

type DeviceInfo = { name: string; id?: string; model?: string; token: boolean };

/** Reads http://host:8001/api/v2/ (or https:8002); null if it isn't a Samsung TV. */
async function deviceInfo(transport: Transport, host: string): Promise<DeviceInfo | null> {
  for (const url of [`http://${host}:8001/api/v2/`, `https://${host}:8002/api/v2/`]) {
    try {
      const response = await httpRequest(transport, { url, timeoutMs: 2500 });
      if (response.status !== 200) continue;
      const info = response.json<{ device?: Record<string, string>; name?: string; type?: string }>();
      const device = info.device ?? {};
      if ((device.type ?? info.type) !== 'Samsung SmartTV') continue;
      return {
        name: (device.name ?? 'Samsung TV').replace(/^\[TV\]\s*/, ''),
        id: device.id ? device.id.replace(/^uuid:/i, '').toLowerCase() : device.wifiMac?.toLowerCase(),
        model: device.modelName,
        token: device.TokenAuthSupport === 'true',
      };
    } catch {
      // try the next URL
    }
  }
  return null;
}

/** A 2015 H/J model needs the old encrypted protocol, which has no text input: skip it. */
const isEncryptedOnly = (model?: string) => !!model && (model[4] === 'H' || model[4] === 'J');

class SamsungSession implements TvSession {
  readonly textMode = 'replace' as const;
  ready = true;
  closed = false;
  /** True while the TV reports its keyboard open. */
  private imeOpen = false;

  constructor(
    private ws: WebSocketClient,
    private events: SessionEvents,
  ) {}

  private send(message: object) {
    if (!this.closed) this.ws.send(JSON.stringify(message));
  }

  updateText(_before: string, after: string) {
    // Replace the whole field. Samsung's own app announces typing once per session, then sends the string.
    this.send({ method: 'ms.channel.emit', params: { event: 'custom.remote.textReceived', to: 'broadcast' } });
    this.send({ method: 'ms.remote.control', params: { Cmd: base64Encode(utf8Encode(after)), DataOfCmd: 'base64', TypeOfRemote: 'SendInputString' } });
  }

  submit() {
    // SendInputEnd presses the on-screen keyboard's Done (tested on 2021 firmware).
    this.send({ method: 'ms.remote.control', params: { TypeOfRemote: 'SendInputEnd' } });
  }

  sendKey(key: NavKey) {
    this.send({ method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: KEYS[key], Option: 'false', TypeOfRemote: 'SendRemoteKey' } });
  }

  close() {
    this.closed = true;
    this.ready = false;
    this.ws.close();
  }

  /** Called by the driver for each TV→phone event. */
  handle(raw: string | Uint8Array) {
    let message: { event?: string; data?: unknown };
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : utf8Decode(raw));
    } catch {
      return;
    }
    switch (message.event) {
      case 'ms.remote.imeStart':
        this.imeOpen = true;
        this.events.onKeyboard?.({ visible: true });
        break;
      case 'ms.remote.imeUpdate': {
        // data is base64 of the field's current text.
        const text = typeof message.data === 'string' ? safeB64Text(message.data) : undefined;
        this.events.onKeyboard?.({ visible: true, text });
        break;
      }
      case 'ms.remote.imeEnd':
        this.imeOpen = false;
        this.events.onKeyboard?.({ visible: false });
        break;
      default:
        break;
    }
  }

  get keyboardOpen() {
    return this.imeOpen;
  }
}

function safeB64Text(data: string): string | undefined {
  try {
    return utf8Decode(base64Decode(data));
  } catch {
    return undefined;
  }
}

/**
 * Opens the socket and waits for ms.channel.connect (or the Allow prompt to be answered).
 * `onAbort` hands the caller a function that closes the socket and rejects right away, so a
 * cancelled pairing doesn't leave the WebSocket open and the (up to 60s) timer armed.
 */
function openChannel(
  transport: Transport,
  tv: TvInfo,
  name: string,
  token: string | null,
  onEvent: (raw: string | Uint8Array) => void,
  events: SessionEvents,
  waitMs: number,
  onAbort?: (abort: () => void) => void,
): Promise<{ ws: WebSocketClient; token: string | null }> {
  return new Promise((resolve, reject) => {
    let ws: WebSocketClient | null = null;
    let settled = false;
    let aborted = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const abort = () => {
      if (settled) return;
      settled = true;
      aborted = true;
      if (timer) clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        // closing anyway
      }
      reject(new PairingError('Se canceló', 'closed'));
    };
    onAbort?.(abort);
    void (async () => {
      let socket: WebSocketClient;
      try {
        socket = await WebSocketClient.connect(transport, socketUrl(tv, name, token), { timeoutMs: 6000 });
      } catch (e) {
        if (!settled) {
          settled = true;
          reject(e as Error);
        }
        return;
      }
      ws = socket;
      if (aborted) {
        // cancel() fired while the socket was still connecting: drop it now instead of lingering.
        try {
          socket.close();
        } catch {
          // closing anyway
        }
        return;
      }
      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.close();
          reject(new PairingError('No hubo respuesta en la tele', 'timeout'));
        }
      }, waitMs);
      socket.setHandlers(
        (raw) => {
          let message: { event?: string; data?: { token?: string | number } };
          try {
            message = JSON.parse(typeof raw === 'string' ? raw : utf8Decode(raw));
          } catch {
            return;
          }
          if (!settled) {
            if (message.event === 'ms.channel.connect') {
              settled = true;
              if (timer) clearTimeout(timer);
              const newToken = message.data?.token != null ? String(message.data.token) : token;
              resolve({ ws: socket, token: newToken });
            } else if (message.event === 'ms.channel.unauthorized' || message.event === 'ms.channel.timeOut') {
              settled = true;
              if (timer) clearTimeout(timer);
              socket.close();
              reject(new PairingError('La tele no dio permiso', message.event === 'ms.channel.timeOut' ? 'timeout' : 'rejected'));
            }
          } else {
            onEvent(raw);
          }
        },
        (error) => {
          if (!settled) {
            settled = true;
            if (timer) clearTimeout(timer);
            reject(new PairingError(error ?? 'La conexión se cerró', 'closed'));
          } else {
            events.onClose('network', error);
          }
        },
      );
    })();
  });
}

export const samsung: Driver = {
  brand: 'samsung',
  label: 'Samsung',
  priority: 60,
  textMode: 'replace',
  reportsKeyboard: true,
  discovery: {
    mdnsTypes: ['_samsungmsf._tcp'],
    probePorts: [8001, 8002],
    manufacturer: /samsung/i,
    async fromMdns(service: MdnsService, ctx) {
      if (service.type !== '_samsungmsf._tcp') return null;
      const info = await deviceInfo(ctx.transport, service.host);
      if (!info || isEncryptedOnly(info.model)) return null;
      return { brand: 'samsung', host: service.host, name: info.name, id: info.id, model: info.model, hints: { token: info.token ? 'yes' : 'no' } };
    },
    async fromPort(host, _port, ctx) {
      const info = await deviceInfo(ctx.transport, host);
      if (!info || isEncryptedOnly(info.model)) return null;
      return { brand: 'samsung', host, name: info.name, id: info.id, model: info.model, hints: { token: info.token ? 'yes' : 'no' } };
    },
  },

  async refine(tv, ctx) {
    const info = await deviceInfo(ctx.transport, tv.host);
    if (!info) return tv;
    return { ...tv, name: isIpName(tv.name) ? info.name : tv.name, model: info.model ?? tv.model, id: tv.id ?? info.id, hints: { ...tv.hints, token: info.token ? 'yes' : 'no' } };
  },

  async connect(tv, credentials, events, ctx) {
    const token = tv.hints?.token === 'yes' ? (credentials?.token ?? null) : null;
    if (tv.hints?.token === 'yes' && !token) throw new PairingRequired();
    let channel;
    try {
      channel = await openChannel(ctx.transport, tv, ctx.clientName, token, () => {}, events, 10_000);
    } catch (e) {
      // A stored token the TV no longer honours: pair again.
      if (e instanceof PairingError && e.code === 'rejected') throw new PairingRequired();
      throw e;
    }
    const session: SamsungSession = new SamsungSession(channel.ws, events);
    channel.ws.setHandlers(
      (raw) => session.handle(raw),
      (error) => {
        if (!session.closed) {
          session.closed = true;
          session.ready = false;
          events.onClose('network', error);
        }
      },
    );
    const saved = channel.token && channel.token !== token ? { token: channel.token } : undefined;
    return { session, saved };
  },

  async startPairing(tv, ctx): Promise<PairingFlow> {
    // Samsung has no code: opening the socket makes the TV show an Allow prompt.
    let cancelled = false;
    let abort: (() => void) | null = null;
    const accepted = (async (): Promise<Credentials> => {
      const channel = await openChannel(ctx.transport, tv, ctx.clientName, null, () => {}, { onClose: () => {} }, 60_000, (fn) => {
        abort = fn;
        if (cancelled) fn();
      });
      channel.ws.close();
      if (cancelled) throw new PairingError('Se canceló', 'closed');
      if (!channel.token) throw new PairingError('La tele no dio un token', 'rejected');
      return { token: channel.token };
    })();
    accepted.catch(() => {});
    return {
      prompt: {
        kind: 'accept',
        title: 'Permití el celular en la tele',
        message: `${tv.name || 'La tele'} va a preguntar si permitís este celular. Elegí «Permitir» con el control. Se hace una sola vez.`,
      },
      accepted,
      cancel() {
        // Close the in-flight socket and clear its 60s timer now, rather than leaving both alive.
        cancelled = true;
        abort?.();
      },
      onClose() {
        // No separate close signal: the accepted promise rejects on timeout.
      },
    };
  },
};

