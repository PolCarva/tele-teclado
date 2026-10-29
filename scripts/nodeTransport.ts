// Transport for the Mac test tool: node:tls with a client certificate made with openssl.

import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';

import { base64Decode, hexToBytes } from '../src/protocol/bytes';
import { BufferedConnection, TransportError, type PublicKey, type Transport } from '../src/protocol/transport';

const IDENTITY_DIR = path.join(__dirname, '.identity');
const KEY_FILE = path.join(IDENTITY_DIR, 'client-key.pem');
const CERT_FILE = path.join(IDENTITY_DIR, 'client-cert.pem');

function ensureIdentity(): { key: string; cert: string } {
  if (!fs.existsSync(KEY_FILE) || !fs.existsSync(CERT_FILE)) {
    fs.mkdirSync(IDENTITY_DIR, { recursive: true });
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', KEY_FILE, '-out', CERT_FILE,
      '-days', '7300', '-subj', '/CN=tele-teclado-mac',
    ], { stdio: 'ignore' });
  }
  return { key: fs.readFileSync(KEY_FILE, 'utf8'), cert: fs.readFileSync(CERT_FILE, 'utf8') };
}

function base64UrlToBytes(text: string): Uint8Array {
  return base64Decode(text.replace(/-/g, '+').replace(/_/g, '/'));
}

class NodeConnection extends BufferedConnection {
  constructor(
    private socket: tls.TLSSocket,
    serverKey: PublicKey,
  ) {
    super(serverKey);
    let lastError: string | null = null;
    socket.on('data', (chunk: Buffer) => this.deliverData(new Uint8Array(chunk)));
    socket.on('error', (err) => {
      lastError = err.message;
    });
    socket.on('close', () => this.deliverClose(lastError));
  }

  write(data: Uint8Array) {
    this.socket.write(data);
  }

  close() {
    this.socket.destroy();
  }
}

export const nodeTransport: Transport = {
  async getClientKey() {
    const { cert } = ensureIdentity();
    const jwk = new X509Certificate(cert).publicKey.export({ format: 'jwk' }) as { n: string; e: string };
    return { modulus: base64UrlToBytes(jwk.n), exponent: base64UrlToBytes(jwk.e) };
  },

  connect(host, port, timeoutMs) {
    const { key, cert } = ensureIdentity();
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = tls.connect({ host, port, key, cert, rejectUnauthorized: false, servername: '' });
      const timer = setTimeout(() => fail(new TransportError('timeout', 'network')), timeoutMs);
      const fail = (error: TransportError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      socket.once('error', (err: NodeJS.ErrnoException) => {
        fail(new TransportError(err.message, err.code?.startsWith('ERR_SSL') ? 'tls' : 'network'));
      });
      socket.once('secureConnect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const peer = socket.getPeerCertificate();
        resolve(new NodeConnection(socket, { modulus: hexToBytes(peer.modulus ?? ''), exponent: hexToBytes(peer.exponent ?? '') }));
      });
    });
  },
};
