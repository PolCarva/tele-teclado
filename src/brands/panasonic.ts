// Panasonic VIERA (2011+, non-Android): the NRC UPnP/SOAP service on port 55000.
// Text: X_SendString while a text field / on-screen keyboard is open on the TV. It appends and
// there's no way to delete, so the phone box works as a draft that's sent as a whole.
// 2019+ models (and some 2018 ones after an update) need PIN pairing and wrap every command in
// AES-128-CBC + HMAC-SHA256 (X_EncryptedCommand).
// Sources: florianholzapfel/panasonic-viera (Home Assistant), AntonioMeireles/homebridge-vieramatic,
// FastyBird Viera connector; crypto vectors checked in scripts/tests/brands.ts.

import { base64Decode, base64Encode, concatBytes, hexToBytes, utf8Decode, utf8Encode } from '../protocol/bytes';
import { randomBytes, type Transport } from '../protocol/transport';
import { aesCbcDecrypt, aesCbcEncrypt } from '../net/aes';
import { hmacSha256 } from '../net/hash';
import { httpRequest } from '../net/http';
import { SoapError, soapCall } from '../net/soap';
import {
  escapeXml,
  PairingError,
  PairingRequired,
  TvSetupNeeded,
  xmlTag,
  type Credentials,
  type Driver,
  type NavKey,
  type PairingFlow,
  type TvInfo,
  type TvSession,
} from './types';

export const PANASONIC_PORT = 55000;
const NRC = 'urn:panasonic-com:service:p00NetworkControl:1';
/** From libtvconnect.so, via panasonic-viera. */
const HMAC_MASK = hexToBytes('15C95AC2B08AA7EB4E228F811E34D04FA54BA7DCAC9879FA8ACDA3FC244F3854');

export type VieraKeys = { iv: Uint8Array; aesKey: Uint8Array; hmacKey: Uint8Array };

/** Keys for the PIN step, derived from the TV's challenge. */
export function pairingKeys(challenge: Uint8Array): VieraKeys {
  const c = challenge;
  const aesKey = new Uint8Array(16);
  for (let i = 0; i < 16; i += 4) {
    aesKey[i] = ~c[i + 3] & 0xff;
    aesKey[i + 1] = ~c[i + 2] & 0xff;
    aesKey[i + 2] = ~c[i + 1] & 0xff;
    aesKey[i + 3] = ~c[i] & 0xff;
  }
  const hmacKey = new Uint8Array(32);
  for (let i = 0; i < 32; i += 4) {
    hmacKey[i] = HMAC_MASK[i] ^ c[(i + 2) & 15];
    hmacKey[i + 1] = HMAC_MASK[i + 1] ^ c[(i + 3) & 15];
    hmacKey[i + 2] = HMAC_MASK[i + 2] ^ c[i & 15];
    hmacKey[i + 3] = HMAC_MASK[i + 3] ^ c[(i + 1) & 15];
  }
  return { iv: c.slice(0, 16), aesKey, hmacKey };
}

/** Keys for a session, derived from the long-lived key the TV gave us when pairing. */
export function sessionKeys(encKey: Uint8Array): VieraKeys {
  const k = encKey;
  const aesKey = new Uint8Array(16);
  for (let i = 0; i < 16; i += 4) {
    aesKey[i] = k[i + 2];
    aesKey[i + 1] = k[i + 3];
    aesKey[i + 2] = k[i];
    aesKey[i + 3] = k[i + 1];
  }
  return { iv: k.slice(0, 16), aesKey, hmacKey: concatBytes(k, k) };
}

/** 12 random bytes, big-endian byte length, the UTF-8 text, zero padding; AES-CBC; + HMAC. */
export function seal(keys: VieraKeys, text: string, random12: Uint8Array): string {
  const data = utf8Encode(text);
  let pad = 16 - ((16 + data.length) % 16);
  if (pad === 0) pad = 16;
  const plain = new Uint8Array(16 + data.length + pad);
  plain.set(random12.subarray(0, 12));
  new DataView(plain.buffer).setUint32(12, data.length);
  plain.set(data, 16);
  const ct = aesCbcEncrypt(keys.aesKey, keys.iv, plain);
  return base64Encode(concatBytes(ct, hmacSha256(keys.hmacKey, ct)));
}

export function open(keys: VieraKeys, b64: string): string {
  const raw = base64Decode(b64);
  if (raw.length < 48) throw new Error('Respuesta cifrada demasiado corta');
  const ct = raw.subarray(0, raw.length - 32);
  const plain = aesCbcDecrypt(keys.aesKey, keys.iv, ct.subarray(0, ct.length - (ct.length % 16)));
  const body = plain.subarray(16);
  const end = body.indexOf(0);
  return utf8Decode(end >= 0 ? body.subarray(0, end) : body);
}

const KEYS: Record<NavKey, string> = {
  enter: 'NRC_ENTER-ONOFF',
  back: 'NRC_RETURN-ONOFF',
  up: 'NRC_UP-ONOFF',
  down: 'NRC_DOWN-ONOFF',
  left: 'NRC_LEFT-ONOFF',
  right: 'NRC_RIGHT-ONOFF',
  home: 'NRC_HOME-ONOFF',
};

const controlUrl = (host: string) => `http://${host}:${PANASONIC_PORT}/nrc/control_0`;

/** Real TVs answer GETs from any subnet but refuse every SOAP POST from another subnet with 403. */
const FORBIDDEN =
  'La tele no acepta comandos de este celular. Conectalo a la misma red que la tele (no la de invitados ni otra red del router) y fijate que en la tele esté activado Menú → Red → Ajustes de la app TV Remote.';
const forbidden = (e: unknown) => e instanceof SoapError && e.status === 403;

/** Reads /nrc/ddd.xml; null if it isn't a VIERA. */
async function describe(transport: Transport, host: string): Promise<TvInfo | null> {
  const response = await httpRequest(transport, { url: `http://${host}:${PANASONIC_PORT}/nrc/ddd.xml`, timeoutMs: 2500 });
  const xml = response.text();
  if (response.status !== 200 || !/p00RemoteController|Panasonic VIErA/i.test(xml)) return null;
  const udn = xmlTag(xml, 'UDN');
  return {
    brand: 'panasonic',
    host,
    name: (xmlTag(xml, 'friendlyName') ?? 'Panasonic VIERA').replace(/_/g, ' '),
    id: udn ? udn.replace(/^uuid:/i, '').toLowerCase() : undefined,
    model: xmlTag(xml, 'modelNumber'),
  };
}

class VieraClient {
  private queue: Promise<unknown> = Promise.resolve();
  private sessionId: string | null = null;
  private seq = 1;

  constructor(
    private transport: Transport,
    private host: string,
    private credentials: { appId: string; encKey: string } | null,
  ) {}

  get encrypted() {
    return !!this.credentials;
  }

  /** Runs calls one at a time: encrypted TVs need their sequence numbers in order. */
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  async openSession(): Promise<void> {
    const creds = this.credentials!;
    const keys = sessionKeys(base64Decode(creds.encKey));
    const body = await soapCall(
      this.transport,
      controlUrl(this.host),
      NRC,
      'X_GetEncryptSessionId',
      `<X_ApplicationId>${creds.appId}</X_ApplicationId><X_EncInfo>${seal(keys, `<X_ApplicationId>${creds.appId}</X_ApplicationId>`, randomBytes(this.transport, 12))}</X_EncInfo>`,
    );
    const result = open(keys, xmlTag(body, 'X_EncResult') ?? '');
    const id = xmlTag(result, 'X_SessionId');
    if (!id) throw new Error('La tele no dio una sesión');
    this.sessionId = id;
    this.seq = 1;
  }

  /** One NRC action, wrapped in X_EncryptedCommand when the TV needs it. */
  call(action: string, args: string): Promise<string> {
    return this.run(async () => {
      if (!this.credentials) return soapCall(this.transport, controlUrl(this.host), NRC, action, args);
      const attempt = async () => {
        if (!this.sessionId) await this.openSession();
        const keys = sessionKeys(base64Decode(this.credentials!.encKey));
        this.seq += 1;
        const inner =
          `<X_SessionId>${this.sessionId}</X_SessionId><X_SequenceNumber>${String(this.seq).padStart(8, '0')}</X_SequenceNumber>` +
          `<X_OriginalCommand><u:${action} xmlns:u="${NRC}">${args}</u:${action}></X_OriginalCommand>`;
        const body = await soapCall(
          this.transport,
          controlUrl(this.host),
          NRC,
          'X_EncryptedCommand',
          `<X_ApplicationId>${this.credentials!.appId}</X_ApplicationId><X_EncInfo>${seal(keys, inner, randomBytes(this.transport, 12))}</X_EncInfo>`,
        );
        const result = xmlTag(body, 'X_EncResult');
        return result ? open(keys, result) : body;
      };
      try {
        return await attempt();
      } catch (e) {
        // 612 "No such session" (the TV restarted): open a new session and resend once.
        if (e instanceof SoapError && e.upnpCode === 612) {
          this.sessionId = null;
          return attempt();
        }
        throw e;
      }
    });
  }
}

class VieraSession implements TvSession {
  readonly textMode = 'append' as const;
  ready = true;
  closed = false;

  constructor(
    private client: VieraClient,
    private onError: (error: unknown) => void,
  ) {}

  updateText(before: string, after: string) {
    // Append-only: nothing can be deleted from the phone.
    if (this.closed || !after.startsWith(before) || after === before) return;
    const text = after.slice(before.length);
    this.client.call('X_SendString', `<X_String>${escapeXml(text)}</X_String>`).catch(this.onError);
  }

  submit() {
    this.sendKey('enter');
  }

  sendKey(key: NavKey) {
    if (this.closed) return;
    this.client.call('X_SendKey', `<X_KeyEvent>${KEYS[key]}</X_KeyEvent>`).catch(this.onError);
  }

  close() {
    this.closed = true;
    this.ready = false;
  }
}

export const panasonic: Driver = {
  brand: 'panasonic',
  label: 'Panasonic',
  priority: 40,
  textMode: 'append',
  discovery: {
    ssdpTargets: ['urn:panasonic-com:device:p00RemoteController:1', 'urn:panasonic-com:service:p00NetworkControl:1'],
    probePorts: [PANASONIC_PORT],
    async fromSsdp(reply, headers, ctx) {
      const text = `${headers.st ?? ''} ${headers.usn ?? ''} ${headers.location ?? ''}`;
      if (!/p00RemoteController|p00NetworkControl|:55000\/nrc\//i.test(text)) return null;
      return describe(ctx.transport, reply.host);
    },
    fromPort: (host, port, ctx) => (port === PANASONIC_PORT ? describe(ctx.transport, host) : Promise.resolve(null)),
  },

  async refine(tv, ctx) {
    // The action list says whether the TV needs encryption and whether it takes text.
    const response = await httpRequest(ctx.transport, { url: `http://${tv.host}:${PANASONIC_PORT}/nrc/sdd_0.xml`, timeoutMs: 3000 });
    if (response.status !== 200) return tv;
    const xml = response.text();
    const hints = {
      ...tv.hints,
      encrypted: /X_GetEncryptSessionId/.test(xml) ? '1' : '0',
      sendString: /X_SendString/.test(xml) ? '1' : '0',
    };
    return hints.encrypted === tv.hints?.encrypted && hints.sendString === tv.hints?.sendString ? tv : { ...tv, hints };
  },

  async connect(tv, credentials, events, ctx) {
    const encrypted = tv.hints?.encrypted === '1';
    if (encrypted && !(credentials?.appId && credentials?.encKey)) throw new PairingRequired();
    const client = new VieraClient(ctx.transport, tv.host, encrypted ? { appId: credentials!.appId, encKey: credentials!.encKey } : null);
    if (encrypted) {
      try {
        await client.run(() => client.openSession());
      } catch (e) {
        if (forbidden(e)) throw new TvSetupNeeded(FORBIDDEN);
        // The TV no longer knows our key (reset, or it was paired with another phone).
        if (e instanceof SoapError) throw new PairingRequired();
        throw e;
      }
    } else {
      // Plain TVs: make sure it's there (the description answers even with the screen off).
      const response = await httpRequest(ctx.transport, { url: `http://${tv.host}:${PANASONIC_PORT}/nrc/ddd.xml`, timeoutMs: 3000 });
      if (response.status === 403) throw new TvSetupNeeded(FORBIDDEN);
      // ...and that it takes our commands: from another subnet the GET works but every POST gets 403
      // (panasonic-viera#19, vieramatic#21). X_GetInputMode only reads; any other answer is fine here.
      const probe = await soapCall(ctx.transport, controlUrl(tv.host), NRC, 'X_GetInputMode', '', { timeoutMs: 3000 }).catch((e: unknown) => e);
      if (forbidden(probe)) throw new TvSetupNeeded(FORBIDDEN);
    }
    const session: VieraSession = new VieraSession(client, (error) => {
      events.onDebug?.(`panasonic: ${String(error)}`);
      // The TV said no to this command: keep the session. A 403 (refused from another subnet) closes
      // it, and the reconnect explains what to change.
      if (error instanceof SoapError && !forbidden(error)) return;
      if (!session.closed) {
        session.close();
        events.onClose('network', String(error));
      }
    });
    return { session };
  },

  async startPairing(tv, ctx): Promise<PairingFlow> {
    const url = controlUrl(tv.host);
    let closeListener: (() => void) | null = null;
    let cancelled = false;
    const requestPin = async () => {
      const body = await soapCall(ctx.transport, url, NRC, 'X_DisplayPinCode', `<X_DeviceName>${escapeXml(ctx.clientName)}</X_DeviceName>`).catch((e: unknown) => {
        throw forbidden(e) ? new TvSetupNeeded(FORBIDDEN) : e;
      });
      const challenge = xmlTag(body, 'X_ChallengeKey');
      if (!challenge) throw new Error('La tele no mostró un código');
      return base64Decode(challenge);
    };
    let challenge = await requestPin();
    return {
      prompt: {
        kind: 'code',
        length: 4,
        charset: 'digits',
        title: 'Vinculá tu celular',
        message: `Escribí el código de 4 números que aparece en ${tv.name || 'la tele'}. Si no aparece, en la tele activá Menú → Red → Ajustes de la app TV Remote.`,
      },
      async submit(code): Promise<Credentials> {
        if (cancelled) throw new PairingError('Se canceló la vinculación', 'closed');
        const keys = pairingKeys(challenge);
        let body: string;
        try {
          body = await soapCall(
            ctx.transport,
            url,
            NRC,
            'X_RequestAuth',
            `<X_AuthInfo>${seal(keys, `<X_PinCode>${code}</X_PinCode>`, randomBytes(ctx.transport, 12))}</X_AuthInfo>`,
          );
        } catch (e) {
          if (e instanceof SoapError && (e.upnpCode === 600 || e.status === 500)) {
            // Wrong or expired PIN: the TV needs a new one (like Home Assistant does).
            challenge = await requestPin().catch(() => challenge);
            throw new PairingError('Ese código no coincide. La tele muestra uno nuevo.', 'bad_code');
          }
          throw e;
        }
        const result = open(keys, xmlTag(body, 'X_AuthResult') ?? '');
        const appId = xmlTag(result, 'X_ApplicationId');
        const encKey = xmlTag(result, 'X_Keyword');
        if (!appId || !encKey) throw new PairingError('La tele no aceptó el código', 'rejected');
        return { appId, encKey };
      },
      cancel() {
        cancelled = true;
      },
      onClose(listener) {
        closeListener = listener;
        void closeListener;
      },
    };
  },
};
