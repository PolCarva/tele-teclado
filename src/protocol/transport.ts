// The protocol code talks to the TV through this interface. The app implements it with
// a small native module (src/tv/nativeTransport.ts); the Mac test tool uses node:net/tls.
// Everything above raw sockets (HTTP, WebSocket, MQTT and each TV brand) is TypeScript.

export type PublicKey = { modulus: Uint8Array; exponent: Uint8Array };

export interface Connection {
  /** Public key of the TV's certificate (needed for the pairing secret). */
  readonly serverKey: PublicKey;
  write(data: Uint8Array): void;
  close(): void;
  setHandlers(onData: (data: Uint8Array) => void, onClose: (error: string | null) => void): void;
}

/**
 * - `tcp`: plain TCP.
 * - `tls`: TLS without checking the TV's (self-signed) certificate.
 * - `tls-client-cert`: same, presenting this phone's certificate (Android TV remote).
 */
export type SocketMode = 'tcp' | 'tls' | 'tls-client-cert';

/** A service announced over mDNS / Bonjour. */
export type MdnsService = { type: string; name: string; host: string; port: number; txt: Record<string, string> };
/** A reply to an SSDP M-SEARCH: who sent it and the raw HTTP-like text. */
export type SsdpReply = { host: string; response: string };

export interface Transport {
  /** This phone's certificate public key. Created once and kept on the device. */
  getClientKey(): Promise<PublicKey>;
  /** Opens a byte stream. `mode` defaults to `tls-client-cert` (the Android TV remote). */
  connect(host: string, port: number, timeoutMs: number, mode?: SocketMode): Promise<Connection>;
  /** mDNS / Bonjour browse for these service types (e.g. `_androidtvremote2._tcp`). */
  browse?(types: string[], timeoutMs: number): Promise<MdnsService[]>;
  /** SSDP M-SEARCH (multicast, plus unicast to `hosts`). */
  ssdp?(targets: string[], hosts: string[], timeoutMs: number): Promise<SsdpReply[]>;
  /** Which host:port pairs accept TCP connections. */
  probe?(hosts: string[], ports: number[], timeoutMs: number, concurrency: number): Promise<{ host: string; port: number }[]>;
  /** The phone's address on the Wi-Fi. */
  networkInfo?(): Promise<{ ip: string; prefixLength: number } | null>;
  /** Cryptographically secure random bytes. */
  randomBytes?(count: number): Uint8Array;
}

/** Random bytes: secure when the transport offers them, Math.random otherwise (fine for nonces like WebSocket keys). */
export function randomBytes(transport: Pick<Transport, 'randomBytes'> | null, count: number): Uint8Array {
  const secure = transport?.randomBytes?.(count);
  if (secure && secure.length === count) return secure;
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

export class TransportError extends Error {
  constructor(
    message: string,
    readonly code: 'network' | 'tls' | 'unknown',
  ) {
    super(message);
  }
}

/** True when the TV refused our certificate, which means this phone is not paired (anymore). */
export function isCertificateRejection(message: string | null | undefined): boolean {
  return !!message && /certificate|bad_cert|BAD_CERT|CERTIFICATE/i.test(message);
}

/**
 * Connection base that keeps data/close events that arrive before handlers are set,
 * and hands them over (in order) once they are.
 */
export abstract class BufferedConnection implements Connection {
  private onData: ((data: Uint8Array) => void) | null = null;
  private onClose: ((error: string | null) => void) | null = null;
  private pendingData: Uint8Array[] = [];
  private pendingClose: { error: string | null } | null = null;
  private closed = false;

  constructor(readonly serverKey: PublicKey) {}

  abstract write(data: Uint8Array): void;
  abstract close(): void;

  setHandlers(onData: (data: Uint8Array) => void, onClose: (error: string | null) => void) {
    this.onData = onData;
    this.onClose = onClose;
    const data = this.pendingData;
    this.pendingData = [];
    for (const chunk of data) onData(chunk);
    if (this.pendingClose) {
      const { error } = this.pendingClose;
      this.pendingClose = null;
      onClose(error);
    }
  }

  protected deliverData(data: Uint8Array) {
    if (this.closed) return;
    if (this.onData) this.onData(data);
    else this.pendingData.push(data);
  }

  protected deliverClose(error: string | null) {
    if (this.closed) return;
    this.closed = true;
    if (this.onClose) this.onClose(error);
    else this.pendingClose = { error };
  }
}
