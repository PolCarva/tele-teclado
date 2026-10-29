// Transport backed by the native module in modules/tv-remote.

import TvRemote from '../../modules/tv-remote/src/TvRemoteModule';
import { base64Decode, base64Encode, hexToBytes } from '../protocol/bytes';
import { BufferedConnection, TransportError, type PublicKey, type Transport } from '../protocol/transport';

class NativeConnection extends BufferedConnection {
  constructor(
    readonly id: number,
    serverKey: PublicKey,
  ) {
    super(serverKey);
  }

  write(data: Uint8Array) {
    TvRemote.write(this.id, base64Encode(data));
  }

  close() {
    TvRemote.close(this.id);
  }

  receive(data: Uint8Array) {
    this.deliverData(data);
  }

  receiveClose(error: string | null) {
    this.deliverClose(error);
  }
}

const open = new Map<number, NativeConnection>();
// Events that arrive before connect() resolves on the JS side.
const early = new Map<number, { data: Uint8Array[]; closed?: string | null }>();

TvRemote.addListener('onData', ({ id, data }) => {
  const bytes = base64Decode(data);
  const conn = open.get(id);
  if (conn) conn.receive(bytes);
  else {
    const pending = early.get(id) ?? { data: [] };
    pending.data.push(bytes);
    early.set(id, pending);
  }
});

TvRemote.addListener('onClose', ({ id, error }) => {
  const conn = open.get(id);
  if (conn) {
    open.delete(id);
    conn.receiveClose(error ?? null);
  } else {
    const pending = early.get(id) ?? { data: [] };
    pending.closed = error ?? null;
    early.set(id, pending);
  }
});

export const nativeTransport: Transport & { resetClientKey(): Promise<void> } = {
  resetClientKey: () => TvRemote.resetClientKey(),

  async getClientKey() {
    const key = await TvRemote.getClientKey();
    return { modulus: hexToBytes(key.modulus), exponent: hexToBytes(key.exponent) };
  },

  async connect(host, port, timeoutMs) {
    let result;
    try {
      result = await TvRemote.connect(host, port, timeoutMs);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      const code = err.code === 'ERR_TLS' ? 'tls' : err.code === 'ERR_NETWORK' ? 'network' : 'unknown';
      throw new TransportError(err.message ?? 'connect failed', code);
    }
    const conn = new NativeConnection(result.id, {
      modulus: hexToBytes(result.serverModulus),
      exponent: hexToBytes(result.serverExponent),
    });
    const pending = early.get(result.id);
    early.delete(result.id);
    if (pending?.closed === undefined) open.set(result.id, conn);
    for (const chunk of pending?.data ?? []) conn.receive(chunk);
    if (pending && pending.closed !== undefined) conn.receiveClose(pending.closed);
    return conn;
  },

  async discover(timeoutMs) {
    try {
      return await TvRemote.discover(timeoutMs);
    } catch {
      return [];
    }
  },
};

export const settings = {
  get: (key: string) => TvRemote.getSetting(key),
  set: (key: string, value: string | null) => TvRemote.setSetting(key, value),
};
