// The protocol code talks to the TV through this interface. The app implements it with
// a small native module (TLS with a client certificate); the Mac test tool uses node:tls.

export type PublicKey = { modulus: Uint8Array; exponent: Uint8Array };

export interface Connection {
  /** Public key of the TV's certificate (needed for the pairing secret). */
  readonly serverKey: PublicKey;
  write(data: Uint8Array): void;
  close(): void;
  setHandlers(onData: (data: Uint8Array) => void, onClose: (error: string | null) => void): void;
}

export type DiscoveredTv = { name: string; host: string };

export interface Transport {
  /** This phone's certificate public key. Created once and kept on the device. */
  getClientKey(): Promise<PublicKey>;
  connect(host: string, port: number, timeoutMs: number): Promise<Connection>;
  /** Looks for Android TVs on the Wi-Fi (mDNS). Optional. */
  discover?(timeoutMs: number): Promise<DiscoveredTv[]>;
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
