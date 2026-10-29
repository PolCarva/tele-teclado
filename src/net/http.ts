// Minimal HTTP/1.1 client on top of the transport's sockets. TVs serve plain http on LAN
// addresses or https with self-signed certificates, which the phone's own HTTP stacks refuse
// or need special settings for; raw sockets work the same everywhere.

import { concatBytes, utf8Decode, utf8Encode } from '../protocol/bytes';
import type { Connection, Transport } from '../protocol/transport';
import { hostHeader, parseUrl } from './url';

export type HttpRequest = {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
};

export type HttpResponse = {
  status: number;
  statusText: string;
  /** Lower-case names. Repeated headers are joined with ", " (Set-Cookie with "\n"). */
  headers: Record<string, string>;
  body: Uint8Array;
  text(): string;
  json<T = unknown>(): T;
};

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly response?: HttpResponse,
  ) {
    super(message);
  }
}

const CRLFCRLF = [13, 10, 13, 10];

function indexOfSeq(data: Uint8Array, seq: number[], from = 0): number {
  outer: for (let i = from; i <= data.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) if (data[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}

export type ResponseHead = { status: number; statusText: string; headers: Record<string, string> };

/** Splits "status line + headers" off a buffer. Returns null until the blank line has arrived. */
export function parseHead(data: Uint8Array): { head: ResponseHead; rest: Uint8Array } | null {
  const end = indexOfSeq(data, CRLFCRLF);
  if (end < 0) return null;
  const lines = utf8Decode(data.subarray(0, end)).split('\r\n');
  const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/i.exec(lines[0] ?? '');
  if (!status) throw new HttpError(`Respuesta HTTP inválida: ${lines[0]}`, 0);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name in headers) headers[name] += name === 'set-cookie' ? '\n' + value : ', ' + value;
    else headers[name] = value;
  }
  return { head: { status: Number(status[1]), statusText: status[2], headers }, rest: data.subarray(end + 4) };
}

/** Decodes a chunked body. Returns null while incomplete. */
function dechunk(data: Uint8Array): Uint8Array | null {
  const parts: Uint8Array[] = [];
  let i = 0;
  for (;;) {
    const lineEnd = indexOfSeq(data, [13, 10], i);
    if (lineEnd < 0) return null;
    const size = parseInt(utf8Decode(data.subarray(i, lineEnd)).split(';')[0].trim(), 16);
    if (Number.isNaN(size)) throw new HttpError('Cuerpo chunked inválido', 0);
    const start = lineEnd + 2;
    if (size === 0) return concatBytes(...parts);
    if (data.length < start + size + 2) return null;
    parts.push(data.subarray(start, start + size));
    i = start + size + 2;
  }
}

function makeResponse(head: ResponseHead, body: Uint8Array): HttpResponse {
  return {
    ...head,
    body,
    text: () => utf8Decode(body),
    json: <T>() => JSON.parse(utf8Decode(body)) as T,
  };
}

/** Collects a full response from a stream. `complete` returns the response when it has all of it. */
export class ResponseReader {
  private buffer: Uint8Array = new Uint8Array(0);
  private head: ResponseHead | null = null;
  private body: Uint8Array = new Uint8Array(0);

  constructor(private readonly method: string) {}

  /** Feeds bytes; returns the response once it's complete (by length or chunked end). */
  push(chunk: Uint8Array): HttpResponse | null {
    if (!this.head) {
      this.buffer = concatBytes(this.buffer, chunk);
      const parsed = parseHead(this.buffer);
      if (!parsed) return null;
      this.head = parsed.head;
      this.body = parsed.rest;
      this.buffer = new Uint8Array(0);
    } else {
      this.body = concatBytes(this.body, chunk);
    }
    return this.check(false);
  }

  /** The server closed the connection: whatever arrived is the body. */
  end(): HttpResponse | null {
    if (!this.head) return null;
    return this.check(true);
  }

  private check(closed: boolean): HttpResponse | null {
    const head = this.head!;
    const noBody = this.method === 'HEAD' || head.status === 204 || head.status === 304 || (head.status >= 100 && head.status < 200);
    if (noBody) return makeResponse(head, new Uint8Array(0));
    if (/chunked/i.test(head.headers['transfer-encoding'] ?? '')) {
      const body = dechunk(this.body);
      return body ? makeResponse(head, body) : closed ? makeResponse(head, this.body) : null;
    }
    const length = head.headers['content-length'];
    if (length !== undefined) {
      const n = Number(length);
      if (this.body.length >= n) return makeResponse(head, this.body.subarray(0, n));
      return closed ? makeResponse(head, this.body) : null;
    }
    return closed ? makeResponse(head, this.body) : null;
  }
}

/** Builds the request bytes. */
export function encodeRequest(
  method: string,
  path: string,
  host: string,
  headers: Record<string, string>,
  body?: string | Uint8Array,
): Uint8Array {
  const bodyBytes = body === undefined ? undefined : typeof body === 'string' ? utf8Encode(body) : body;
  const all: Record<string, string> = { Host: host, ...headers };
  const lower = new Set(Object.keys(all).map((k) => k.toLowerCase()));
  if (!lower.has('connection')) all.Connection = 'close';
  if (!lower.has('user-agent')) all['User-Agent'] = 'TecladoTV/1.0';
  if (!lower.has('accept')) all.Accept = '*/*';
  if (bodyBytes && !lower.has('content-length')) all['Content-Length'] = String(bodyBytes.length);
  let text = `${method} ${path} HTTP/1.1\r\n`;
  for (const [k, v] of Object.entries(all)) text += `${k}: ${v}\r\n`;
  text += '\r\n';
  return bodyBytes ? concatBytes(utf8Encode(text), bodyBytes) : utf8Encode(text);
}

/** One request on its own connection (Connection: close). Rejects on network errors and timeouts, not on HTTP status. */
export async function httpRequest(transport: Transport, request: HttpRequest): Promise<HttpResponse> {
  const url = parseUrl(request.url);
  const method = (request.method ?? (request.body !== undefined ? 'POST' : 'GET')).toUpperCase();
  const timeoutMs = request.timeoutMs ?? 6000;
  const started = Date.now();
  const conn: Connection = await transport.connect(url.host, url.port, timeoutMs, url.secure ? 'tls' : 'tcp');
  return new Promise<HttpResponse>((resolve, reject) => {
    const reader = new ResponseReader(method);
    let settled = false;
    const finish = (error: Error | null, response?: HttpResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.close();
      if (error) reject(error);
      else resolve(response!);
    };
    const timer = setTimeout(
      () => finish(new HttpError(`Sin respuesta de ${url.host}:${url.port} (timeout)`, 0)),
      Math.max(500, timeoutMs - (Date.now() - started)),
    );
    conn.setHandlers(
      (data) => {
        try {
          const response = reader.push(data);
          if (response) finish(null, response);
        } catch (e) {
          finish(e as Error);
        }
      },
      (error) => {
        const response = reader.end();
        if (response) finish(null, response);
        else finish(new HttpError(error ?? `La conexión con ${url.host} se cerró sin respuesta`, 0));
      },
    );
    conn.write(encodeRequest(method, url.path, hostHeader(url), request.headers ?? {}, request.body));
  });
}
