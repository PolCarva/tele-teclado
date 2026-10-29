// Android TV / Google TV (TCL, Sony, Philips, Hisense, Xiaomi, Sharp, Chromecast with Google TV,
// Nvidia Shield…): the Android TV Remote protocol v2 in src/protocol (tested on a real TCL).

import { KeyCode } from '../protocol/messages';
import { PairingError as ProtocolPairingError, PairingSession } from '../protocol/pairing';
import { RemoteSession } from '../protocol/session';
import { isCertificateRejection, TransportError } from '../protocol/transport';
import {
  diffText,
  PairingError,
  PairingRequired,
  type Driver,
  type NavKey,
  type PairingFlow,
  type TvSession,
} from './types';

const KEYS: Record<NavKey, number> = {
  enter: KeyCode.ENTER,
  back: KeyCode.BACK,
  up: KeyCode.DPAD_UP,
  down: KeyCode.DPAD_DOWN,
  left: KeyCode.DPAD_LEFT,
  right: KeyCode.DPAD_RIGHT,
  home: KeyCode.HOME,
};

class AndroidTvSession implements TvSession {
  readonly textMode = 'insert' as const;

  constructor(private remote: RemoteSession) {}

  get ready() {
    return this.remote.ready && !this.remote.closed;
  }

  get closed() {
    return this.remote.closed;
  }

  get currentApp() {
    return this.remote.currentApp;
  }

  updateText(before: string, after: string) {
    const { deletes, insert } = diffText(before, after);
    // The TV inserts at its cursor: delete what changed, then type the rest.
    this.remote.sendDeletes(deletes);
    this.remote.sendText(insert);
  }

  submit() {
    this.remote.sendKey(KeyCode.ENTER);
  }

  sendKey(key: NavKey) {
    this.remote.sendKey(KEYS[key]);
  }

  openLink(url: string) {
    this.remote.openLink(url);
  }

  close() {
    this.remote.close();
  }
}

export const androidTv: Driver = {
  brand: 'androidtv',
  label: 'Android TV',
  priority: 100,
  textMode: 'insert',
  appLinks: true,
  warmUpMs: 700,
  discovery: {
    mdnsTypes: ['_androidtvremote2._tcp'],
    probePorts: [6466],
    fromMdns: (s) =>
      s.type === '_androidtvremote2._tcp'
        ? { brand: 'androidtv', host: s.host, name: s.name, id: s.txt.bt ? `bt:${s.txt.bt.toLowerCase()}` : undefined }
        : null,
    fromPort: async (host, port) => (port === 6466 ? { brand: 'androidtv', host, name: host } : null),
  },

  async connect(tv, _credentials, events, ctx) {
    // Resolves once the handshake is done: ready, or closed because the TV doesn't know this phone.
    let settled = false;
    let settle: (error: Error | null) => void = () => {};
    let remote: RemoteSession | null = null;
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        remote?.close();
        settle(new TransportError('La tele no terminó de conectar', 'network'));
      }, 8000);
      settle = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
    });
    try {
      remote = await RemoteSession.open(ctx.transport, tv.host, {
        onReady: () => settle(null),
        onClose: (reason, detail) => {
          if (!settled) {
            settle(reason === 'needs_pairing' ? new PairingRequired() : new TransportError(detail ?? 'closed', 'network'));
          } else {
            events.onClose(reason, detail);
          }
        },
        onApp: (app) => events.onApp?.(app),
        onDebug: events.onDebug,
      });
    } catch (e) {
      settle(e as Error);
      done.catch(() => {});
      if (e instanceof TransportError && e.code === 'tls' && isCertificateRejection(e.message)) throw new PairingRequired();
      throw e;
    }
    await done;
    return { session: new AndroidTvSession(remote) };
  },

  async startPairing(tv, ctx): Promise<PairingFlow> {
    const pairing = await PairingSession.start(ctx.transport, tv.host, ctx.clientName);
    return {
      prompt: {
        kind: 'code',
        length: 6,
        charset: 'hex',
        title: 'Vinculá tu celular',
        message: `Escribí el código que aparece en ${tv.name || 'la tele'}. Se hace una sola vez.`,
      },
      async submit(code) {
        try {
          await pairing.finish(code);
        } catch (e) {
          if (e instanceof ProtocolPairingError) throw new PairingError(e.message, e.code);
          throw e;
        }
        return {};
      },
      cancel: () => pairing.cancel(),
      onClose(listener) {
        pairing.onClose(listener);
        if (pairing.isClosed) listener();
      },
    };
  },
};

