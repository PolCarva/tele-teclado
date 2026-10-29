// Minimal WebSocket client (RFC 6455) on top of the transport's sockets, so TV WebSockets
// with self-signed certificates (wss://…:8002, :3001) work the same on Android and iPhone.

import { base64Encode, concatBytes, utf8Decode, utf8Encode } from '../protocol/bytes';
import { randomBytes, type Connection, type Transport } from '../protocol/transport';
import { sha1 } from './hash';
import { parseHead } from './http';
import { hostHeader, parseUrl } from './url';

export type WebSocketOptions = {
  headers?: Record<string, string>;
  protocols?: string[];
  timeoutMs?: number;
};

export class WebSocketError extends Error {
  constructor(
    message: string,
    /** HTTP status when the server refused the upgrade. */
    readonly status = 0,
  ) {
    super(message);
  }
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptKey(key: string): string {
  return base64Encode(sha1(utf8Encode(key + GUID)));
}

/** Encodes one client frame (always masked, as RFC 6455 requires from clients). */
export function encodeFrame(opcode: number, payload: Uint8Array, mask: Uint8Array): Uint8Array {
  let header: number[];
  const len = payload.length;
  if (len < 126) header = [0x80 | opcode, 0x80 | len];
  else if (len < 65536) header = [0x80 | opcode, 0x80 | 126, len >> 8, len & 0xff];
  else {
    header = [0x80 | opcode, 0x80 | 127, 0, 0, 0, 0];
    header.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
  }
  const out = new Uint8Array(header.length + 4 + len);
  out.set(header);
  out.set(mask, header.length);
  for (let i = 0; i < len; i++) out[header.length + 4 + i] = payload[i] ^ mask[i & 3];
  return out;
}

type Frame = { fin: boolean; opcode: number; payload: Uint8Array };

/** Decodes frames from a byte stream (server frames may or may not be masked). */
export class FrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    this.buffer = this.buffer.length ? concatBytes(this.buffer, chunk) : chunk;
    const frames: Frame[] = [];
    for (;;) {
      const b = this.buffer;
      if (b.length < 2) break;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (b.length < 4) break;
        len = (b[2] << 8) | b[3];
        offset = 4;
      } else if (len === 127) {
        if (b.length < 10) break;
        len = ((b[6] << 24) >>> 0) + ((b[7] << 16) | (b[8] << 8) | b[9]) + b[5] * 2 ** 32;
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (b.length < offset + maskLen + len) break;
      let payload = b.slice(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = b.subarray(offset, offset + 4);
        payload = payload.map((v, i) => v ^ mask[i & 3]);
      }
      frames.push({ fin, opcode, payload });
      this.buffer = b.subarray(offset + maskLen + len);
    }
    return frames;
  }
}

export class WebSocketClient {
  private decoder = new FrameDecoder();
  private fragments: Uint8Array[] = [];
  private fragmentOpcode = 0;
  private closed = false;
  private onMessage: (message: string | Uint8Array) => void = () => {};
  private onClose: (error: string | null) => void = () => {};
  private early: (string | Uint8Array)[] = [];
  private earlyClose: { error: string | null } | null = null;
  private handlersSet = false;
  /** When the TV last sent anything (frames, pings), for liveness checks. */
  lastReceivedAt = Date.now();

  private constructor(
    private conn: Connection,
    private transport: Transport,
    /** Headers of the server's 101 response. */
    readonly responseHeaders: Record<string, string>,
  ) {}

  static async connect(transport: Transport, url: string, options: WebSocketOptions = {}): Promise<WebSocketClient> {
    const parsed = parseUrl(url);
    const timeoutMs = options.timeoutMs ?? 6000;
    const conn = await transport.connect(parsed.host, parsed.port, timeoutMs, parsed.secure ? 'tls' : 'tcp');
    const key = base64Encode(randomBytes(transport, 16));
    const headers: Record<string, string> = {
      Host: hostHeader(parsed),
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
      ...(options.protocols?.length ? { 'Sec-WebSocket-Protocol': options.protocols.join(', ') } : {}),
      ...options.headers,
    };
    let request = `GET ${parsed.path} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(headers)) request += `${k}: ${v}\r\n`;
    request += '\r\n';

    return new Promise<WebSocketClient>((resolve, reject) => {
      let buffer: Uint8Array = new Uint8Array(0);
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        conn.close();
        reject(error);
      };
      const timer = setTimeout(() => fail(new WebSocketError(`Sin respuesta de ${parsed.host}:${parsed.port} (timeout)`)), timeoutMs);
      conn.setHandlers(
        (data) => {
          if (settled) return;
          buffer = concatBytes(buffer, data);
          let parsedHead;
          try {
            parsedHead = parseHead(buffer);
          } catch (e) {
            return fail(e as Error);
          }
          if (!parsedHead) return;
          const { head, rest } = parsedHead;
          if (head.status !== 101) {
            return fail(new WebSocketError(`La tele rechazó la conexión (HTTP ${head.status} ${head.statusText})`, head.status));
          }
          const accept = head.headers['sec-websocket-accept'];
          if (accept && accept !== acceptKey(key)) return fail(new WebSocketError('Respuesta WebSocket inválida'));
          settled = true;
          clearTimeout(timer);
          const ws = new WebSocketClient(conn, transport, head.headers);
          conn.setHandlers(
            (chunk) => ws.receive(chunk),
            (error) => ws.finish(error),
          );
          if (rest.length) ws.receive(rest);
          resolve(ws);
        },
        (error) => fail(new WebSocketError(error ?? `La conexión con ${parsed.host} se cerró`)),
      );
      conn.write(utf8Encode(request));
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Messages that arrived before this call are delivered right away, in order. */
  setHandlers(onMessage: (message: string | Uint8Array) => void, onClose: (error: string | null) => void) {
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.handlersSet = true;
    for (const message of this.early.splice(0)) onMessage(message);
    if (this.earlyClose) onClose(this.earlyClose.error);
  }

  send(message: string | Uint8Array) {
    if (this.closed) return;
    const binary = typeof message !== 'string';
    this.conn.write(encodeFrame(binary ? 2 : 1, binary ? message : utf8Encode(message), randomBytes(this.transport, 4)));
  }

  ping() {
    if (!this.closed) this.conn.write(encodeFrame(9, new Uint8Array(0), randomBytes(this.transport, 4)));
  }

  close() {
    if (this.closed) return;
    try {
      this.conn.write(encodeFrame(8, new Uint8Array([0x03, 0xe8]), randomBytes(this.transport, 4)));
    } catch {
      // closing anyway
    }
    this.conn.close();
    this.finish(null);
  }

  private receive(chunk: Uint8Array) {
    this.lastReceivedAt = Date.now();
    let frames: Frame[];
    try {
      frames = this.decoder.push(chunk);
    } catch {
      this.conn.close();
      return this.finish('Trama WebSocket inválida');
    }
    for (const frame of frames) {
      if (this.closed) return;
      switch (frame.opcode) {
        case 0x9: // ping
          this.conn.write(encodeFrame(0xa, frame.payload, randomBytes(this.transport, 4)));
          break;
        case 0xa: // pong
          break;
        case 0x8: {
          // close
          const code = frame.payload.length >= 2 ? (frame.payload[0] << 8) | frame.payload[1] : 1005;
          const reason = utf8Decode(frame.payload.subarray(2));
          try {
            this.conn.write(encodeFrame(8, frame.payload.subarray(0, 2), randomBytes(this.transport, 4)));
          } catch {
            // closing anyway
          }
          this.conn.close();
          this.finish(code === 1000 || code === 1005 ? null : `cerrado por la tele (${code}${reason ? ' ' + reason : ''})`);
          return;
        }
        case 0x0: // continuation
          this.fragments.push(frame.payload);
          if (frame.fin) {
            const payload = concatBytes(...this.fragments);
            this.fragments = [];
            this.deliver(this.fragmentOpcode, payload);
          }
          break;
        case 0x1:
        case 0x2:
          if (frame.fin) this.deliver(frame.opcode, frame.payload);
          else {
            this.fragmentOpcode = frame.opcode;
            this.fragments = [frame.payload];
          }
          break;
        default:
          break;
      }
    }
  }

  private deliver(opcode: number, payload: Uint8Array) {
    const message = opcode === 1 ? utf8Decode(payload) : payload;
    if (this.handlersSet) this.onMessage(message);
    else this.early.push(message);
  }

  private finish(error: string | null) {
    if (this.closed) return;
    this.closed = true;
    if (this.handlersSet) this.onClose(error);
    else this.earlyClose = { error };
  }
}
