// Roku players and Roku TVs (TCL, Hisense, Sharp… with Roku OS): the External Control Protocol
// (ECP), plain HTTP on port 8060. Text is one POST /keypress/Lit_<char> per character, with
// Backspace and Enter. No pairing, but Roku OS 14.1+ ships a "Limited" default that blocks
// keypress (HTTP 403) until the user sets "Control by mobile apps" to "Enabled".
// Sources: Roku ECP docs, python-rokuecp (Home Assistant), node-roku-client, openHAB.

import { httpRequest } from '../net/http';
import type { SsdpReply, Transport } from '../protocol/transport';
import { TvSetupNeeded, xmlTag, type Driver, type NavKey, type TvInfo, type TvSession } from './types';

export const ROKU_PORT = 8060;

const KEYS: Record<NavKey, string> = {
  enter: 'Enter',
  back: 'Back',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
};

const SETUP_MESSAGE =
  'En la tele (Roku), andá a Ajustes → Sistema → Ajustes avanzados del sistema → Control por apps móviles y elegí «Activado» (Enabled). Después volvé a intentar.';

const base = (host: string) => `http://${host}:${ROKU_PORT}`;
/** A name that's really just the address (from manual IP entry). */
const isIpName = (name: string) => !name || /^\d+\.\d+\.\d+\.\d+$/.test(name) || name.includes(':');

/** GET /query/device-info. Returns name/model/mode, or null if it isn't a Roku. */
async function deviceInfo(transport: Transport, host: string): Promise<TvInfo | null> {
  let response;
  try {
    response = await httpRequest(transport, { url: `${base(host)}/query/device-info`, timeoutMs: 2500, headers: { Accept: 'text/xml' } });
  } catch {
    return null;
  }
  const server = response.headers.server ?? '';
  const xml = response.text();
  if (!/Roku/i.test(server) && !/<device-info>/i.test(xml)) return null;
  const name =
    xmlTag(xml, 'user-device-name') ||
    xmlTag(xml, 'friendly-device-name') ||
    xmlTag(xml, 'default-device-name') ||
    [xmlTag(xml, 'vendor-name'), xmlTag(xml, 'model-name')].filter(Boolean).join(' ') ||
    'Roku';
  return {
    brand: 'roku',
    host,
    name,
    id: xmlTag(xml, 'serial-number') || xmlTag(xml, 'udn'),
    model: xmlTag(xml, 'model-name'),
    hints: { mode: xmlTag(xml, 'ecp-setting-mode') ?? '' },
  };
}

class RokuSession implements TvSession {
  readonly textMode = 'insert' as const;
  ready = true;
  closed = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private transport: Transport,
    private host: string,
    private onBlocked: () => void,
  ) {}

  private post(path: string) {
    this.enqueue(async () => {
      if (this.closed) return;
      const response = await httpRequest(this.transport, { method: 'POST', url: `${base(this.host)}${path}`, body: '', timeoutMs: 4000 }).catch(() => null);
      // 401 (Disabled) / 403 (Limited): the setting changed under us.
      if (response && (response.status === 401 || response.status === 403)) this.onBlocked();
    });
  }

  updateText(before: string, after: string) {
    // Per-character ECP: Backspace what changed, then one Lit_ request per added code point.
    const a = Array.from(before);
    const b = Array.from(after);
    let same = 0;
    while (same < a.length && same < b.length && a[same] === b[same]) same++;
    for (let i = same; i < a.length; i++) this.post('/keypress/Backspace');
    for (const ch of b.slice(same)) this.post(`/keypress/Lit_${encodeURIComponent(ch)}`);
  }

  submit() {
    this.post('/keypress/Enter');
  }

  sendKey(key: NavKey) {
    this.post(`/keypress/${KEYS[key]}`);
  }

  private enqueue(work: () => Promise<void>) {
    // ECP drops letters sent too fast: one request at a time, in order.
    this.queue = this.queue.then(work, work);
  }

  close() {
    this.closed = true;
    this.ready = false;
  }
}

export const roku: Driver = {
  brand: 'roku',
  label: 'Roku',
  priority: 50,
  textMode: 'insert',
  // Roku's own keyboard has no "search" submit beyond Enter, and search apps vary: no app links.
  discovery: {
    ssdpTargets: ['roku:ecp'],
    probePorts: [ROKU_PORT],
    manufacturer: /roku/i,
    async fromSsdp(reply: SsdpReply, headers, ctx) {
      if (!/roku:ecp/i.test(headers.st ?? '') && !/roku/i.test(headers.server ?? '')) return null;
      return deviceInfo(ctx.transport, reply.host);
    },
    fromPort: (host, _port, ctx) => deviceInfo(ctx.transport, host),
  },

  async refine(tv, ctx) {
    const info = await deviceInfo(ctx.transport, tv.host);
    return info ? { ...tv, name: isIpName(tv.name) ? info.name : tv.name, model: info.model ?? tv.model, id: tv.id ?? info.id, hints: { ...tv.hints, ...info.hints } } : tv;
  },

  async connect(tv, _credentials, events, ctx) {
    // Roku answers 403 to a Host header that isn't an IP address (DNS-rebinding protection).
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(tv.host) && !tv.host.includes(':')) {
      throw new TvSetupNeeded('Para Roku escribí la dirección IP de la tele (por ejemplo 192.168.0.10), no su nombre.');
    }
    // Check the TV takes commands from the phone, with a harmless read: /query/apps is 403 in
    // "Limited" mode and 401 when control is disabled, but keypress/typing need it to be 200.
    const probe = await httpRequest(ctx.transport, { url: `${base(tv.host)}/query/apps`, timeoutMs: 4000, headers: { Accept: 'text/xml' } }).catch(() => null);
    if (!probe) throw new Error('La tele Roku no respondió');
    if (probe.status === 401) throw new TvSetupNeeded('Esta tele Roku tiene el control por red desactivado. Activalo en Ajustes → Sistema → Ajustes avanzados del sistema → Control por apps móviles.');
    if (probe.status === 403) throw new TvSetupNeeded(SETUP_MESSAGE);
    const session: RokuSession = new RokuSession(ctx.transport, tv.host, () => {
      if (!session.closed) {
        session.close();
        events.onClose('network', 'Limited mode');
      }
    });
    return { session };
  },
};

