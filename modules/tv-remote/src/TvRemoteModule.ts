import { NativeModule, requireNativeModule } from 'expo';

export type TvRemoteEvents = {
  /** Bytes received on a connection, base64-encoded. */
  onData: (event: { id: number; data: string }) => void;
  /** A connection closed. `error` is set when it closed because of an error. */
  onClose: (event: { id: number; error?: string }) => void;
};

export type SocketMode = 'tcp' | 'tls' | 'tls-client-cert';

declare class TvRemoteModule extends NativeModule<TvRemoteEvents> {
  /** Public key (hex) of this phone's certificate. Creates the certificate on first use. */
  getClientKey(): Promise<{ modulus: string; exponent: string }>;
  /** Forgets this phone's certificate (the TV will ask to pair again). */
  resetClientKey(): Promise<void>;
  /**
   * Opens a byte stream: plain TCP, TLS (TV certificate not checked), or TLS presenting this
   * phone's certificate. Rejects with code ERR_NETWORK or ERR_TLS. The server key is empty when
   * there is none (plain TCP, non-RSA certificate).
   */
  connect(
    host: string,
    port: number,
    timeoutMs: number,
    mode: SocketMode,
  ): Promise<{ id: number; serverModulus: string; serverExponent: string }>;
  write(id: number, base64: string): boolean;
  close(id: number): void;
  /** Services found over mDNS / Bonjour for these types. */
  browse(
    types: string[],
    timeoutMs: number,
  ): Promise<{ type: string; name: string; host: string; port: number; txt: Record<string, string> }[]>;
  /** SSDP M-SEARCH replies (multicast, plus unicast to `hosts`). */
  ssdp(targets: string[], hosts: string[], timeoutMs: number): Promise<{ host: string; response: string }[]>;
  /** host:port pairs that accept a TCP connection within the timeout. */
  probe(hosts: string[], ports: number[], timeoutMs: number, concurrency: number): Promise<{ host: string; port: number }[]>;
  /** The phone's IPv4 address and prefix length on the Wi-Fi, or null. */
  networkInfo(): Promise<{ ip: string; prefixLength: number } | null>;
  /** Secure random bytes, base64-encoded. */
  randomBytes(count: number): string;
  getSetting(key: string): string | null;
  setSetting(key: string, value: string | null): void;
}

export default requireNativeModule<TvRemoteModule>('TvRemote');
