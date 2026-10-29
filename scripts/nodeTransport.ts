// Transport for the Mac test tool and the tests: node:net / node:tls (with a client
// certificate made with openssl for the Android TV remote), SSDP over node:dgram, a TCP port
// probe, and Bonjour browsing through macOS's dns-sd command.

import { execFile, execFileSync } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

import { base64Decode, hexToBytes } from '../src/protocol/bytes';
import { BufferedConnection, TransportError, type MdnsService, type PublicKey, type SsdpReply, type Transport } from '../src/protocol/transport';

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
    private socket: net.Socket,
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

  connect(host, port, timeoutMs, mode = 'tls-client-cert') {
    const identity = mode === 'tls-client-cert' ? ensureIdentity() : null;
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket: net.Socket =
        mode === 'tcp'
          ? net.connect({ host, port })
          : tls.connect({ host, port, ...(identity ?? {}), rejectUnauthorized: false, servername: '', minVersion: 'TLSv1' });
      socket.setNoDelay(true);
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
      socket.once(mode === 'tcp' ? 'connect' : 'secureConnect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const peer = mode === 'tcp' ? null : (socket as tls.TLSSocket).getPeerCertificate();
        resolve(new NodeConnection(socket, { modulus: hexToBytes(peer?.modulus ?? ''), exponent: hexToBytes(peer?.exponent ?? '') }));
      });
    });
  },

  ssdp(targets, hosts, timeoutMs) {
    return new Promise((resolve) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const replies: SsdpReply[] = [];
      const seen = new Set<string>();
      socket.on('message', (msg, rinfo) => {
        const response = msg.toString('utf8');
        if (seen.has(rinfo.address + response)) return;
        seen.add(rinfo.address + response);
        replies.push({ host: rinfo.address, response });
      });
      socket.on('error', () => {});
      const sendAll = () => {
        for (const st of targets) {
          const m = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`;
          socket.send(m, 1900, '239.255.255.250');
          for (const host of hosts) socket.send(`M-SEARCH * HTTP/1.1\r\nHOST: ${host}:1900\r\nMAN: "ssdp:discover"\r\nST: ${st}\r\n\r\n`, 1900, host);
        }
      };
      socket.bind(0, () => {
        socket.setMulticastTTL(2);
        sendAll();
        setTimeout(sendAll, 700);
      });
      setTimeout(() => {
        socket.close();
        resolve(replies);
      }, timeoutMs);
    });
  },

  async probe(hosts, ports, timeoutMs, concurrency) {
    const queue = hosts.flatMap((host) => ports.map((port) => ({ host, port })));
    const open: { host: string; port: number }[] = [];
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const { host, port } = item;
        await new Promise<void>((done) => {
          const socket = net.connect({ host, port });
          const timer = setTimeout(() => finish(false), timeoutMs);
          const finish = (ok: boolean) => {
            clearTimeout(timer);
            socket.destroy();
            if (ok) open.push({ host, port });
            done();
          };
          socket.once('connect', () => finish(true));
          socket.once('error', () => finish(false));
        });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    return open;
  },

  async networkInfo() {
    for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
      if (!name.startsWith('en')) continue;
      const v4 = addresses?.find((a) => a.family === 'IPv4' && !a.internal);
      if (v4) return { ip: v4.address, prefixLength: Number(v4.cidr?.split('/')[1] ?? 24) };
    }
    return null;
  },

  randomBytes(count) {
    return new Uint8Array(randomBytes(count));
  },

  async browse(types, timeoutMs) {
    return browseWithDnsSd(types, timeoutMs);
  },
};

/** Bonjour via macOS's dns-sd: browse each type, then look up and resolve each instance. */
async function browseWithDnsSd(types: string[], timeoutMs: number): Promise<MdnsService[]> {
  if (process.platform !== 'darwin') return [];
  const run = (args: string[], ms: number) =>
    new Promise<string>((resolve) => {
      const child = execFile('dns-sd', args, { timeout: ms, killSignal: 'SIGTERM' }, (_e, stdout) => resolve(String(stdout ?? '')));
      setTimeout(() => child.kill('SIGTERM'), ms);
    });
  const out: MdnsService[] = [];
  await Promise.all(
    types.map(async (type) => {
      const listing = await run(['-B', type, 'local'], Math.min(2500, timeoutMs));
      const names = new Set<string>();
      for (const line of listing.split('\n')) {
        const m = /\sAdd\s+\d+\s+\d+\s+\S+\s+\S+\s+(.+)$/.exec(line);
        if (m) names.add(m[1].trim());
      }
      await Promise.all(
        [...names].map(async (name) => {
          const detail = await run(['-L', name, type, 'local'], 1500);
          const at = /can be reached at (\S+?)\.?:(\d+)/.exec(detail);
          if (!at) return;
          const txt: Record<string, string> = {};
          const txtLine = detail.split('\n').find((l) => l.startsWith(' ') && l.includes('='));
          for (const pair of txtLine?.trim().split(/\s+(?=[\w-]+=)/) ?? []) {
            const eq = pair.indexOf('=');
            if (eq > 0) txt[pair.slice(0, eq)] = pair.slice(eq + 1);
          }
          const resolved = await run(['-G', 'v4', at[1]], 1500);
          const ip = /\s(\d+\.\d+\.\d+\.\d+)\s/.exec(resolved)?.[1];
          if (ip) out.push({ type, name, host: ip, port: Number(at[2]), txt });
        }),
      );
    }),
  );
  return out;
}
