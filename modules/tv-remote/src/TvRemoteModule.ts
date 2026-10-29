import { NativeModule, requireNativeModule } from 'expo';

export type TvRemoteEvents = {
  /** Bytes received on a connection, base64-encoded. */
  onData: (event: { id: number; data: string }) => void;
  /** A connection closed. `error` is set when it closed because of an error. */
  onClose: (event: { id: number; error?: string }) => void;
};

declare class TvRemoteModule extends NativeModule<TvRemoteEvents> {
  /** Public key (hex) of this phone's certificate. Creates the certificate on first use. */
  getClientKey(): Promise<{ modulus: string; exponent: string }>;
  /** Forgets this phone's certificate (the TV will ask to pair again). */
  resetClientKey(): Promise<void>;
  /** Opens a TLS connection with this phone's certificate. Rejects with code ERR_NETWORK or ERR_TLS. */
  connect(
    host: string,
    port: number,
    timeoutMs: number,
  ): Promise<{ id: number; serverModulus: string; serverExponent: string }>;
  write(id: number, base64: string): boolean;
  close(id: number): void;
  /** Android TVs found on the Wi-Fi (mDNS). */
  discover(timeoutMs: number): Promise<{ name: string; host: string }[]>;
  getSetting(key: string): string | null;
  setSetting(key: string, value: string | null): void;
}

export default requireNativeModule<TvRemoteModule>('TvRemote');
