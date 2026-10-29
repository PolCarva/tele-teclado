// Minimal MQTT client (3.1 / 3.1.1, QoS 0 and 1) on top of the transport's sockets.
// Hisense VIDAA TVs run an MQTT broker the phone app talks to.

import { concatBytes, utf8Decode, utf8Encode } from '../protocol/bytes';
import type { Connection, SocketMode, Transport } from '../protocol/transport';

export type MqttOptions = {
  host: string;
  port: number;
  mode: SocketMode;
  clientId: string;
  username?: string;
  password?: string;
  /** 4 = MQTT 3.1.1 ("MQTT"), 3 = MQTT 3.1 ("MQIsdp"). */
  protocolLevel?: 3 | 4;
  keepAliveSec?: number;
  timeoutMs?: number;
};

export class MqttError extends Error {
  constructor(
    message: string,
    /** CONNACK return code (5 = not authorized, 4 = bad user/password). */
    readonly returnCode = -1,
  ) {
    super(message);
  }
}

function str(text: string): Uint8Array {
  const bytes = utf8Encode(text);
  return concatBytes(new Uint8Array([bytes.length >> 8, bytes.length & 0xff]), bytes);
}

function bin(bytes: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([bytes.length >> 8, bytes.length & 0xff]), bytes);
}

export function encodeRemainingLength(n: number): Uint8Array {
  const out: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Uint8Array.from(out);
}

export function packet(type: number, flags: number, body: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([(type << 4) | flags]), encodeRemainingLength(body.length), body);
}

export type MqttPacket = { type: number; flags: number; body: Uint8Array };

export class PacketDecoder {
  private buffer: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): MqttPacket[] {
    this.buffer = this.buffer.length ? concatBytes(this.buffer, chunk) : chunk;
    const out: MqttPacket[] = [];
    for (;;) {
      const b = this.buffer;
      if (b.length < 2) break;
      let length = 0;
      let multiplier = 1;
      let i = 1;
      let complete = false;
      while (i < b.length && i <= 4) {
        const byte = b[i++];
        length += (byte & 0x7f) * multiplier;
        multiplier *= 128;
        if ((byte & 0x80) === 0) {
          complete = true;
          break;
        }
      }
      if (!complete || b.length < i + length) break;
      out.push({ type: b[0] >> 4, flags: b[0] & 0x0f, body: b.slice(i, i + length) });
      this.buffer = b.subarray(i + length);
    }
    return out;
  }
}

export function connectPacket(o: MqttOptions): Uint8Array {
  const level = o.protocolLevel ?? 4;
  let flags = 0x02; // clean session
  if (o.username !== undefined) flags |= 0x80;
  if (o.password !== undefined) flags |= 0x40;
  const parts: Uint8Array[] = [
    str(level === 3 ? 'MQIsdp' : 'MQTT'),
    new Uint8Array([level, flags, ((o.keepAliveSec ?? 30) >> 8) & 0xff, (o.keepAliveSec ?? 30) & 0xff]),
    str(o.clientId),
  ];
  if (o.username !== undefined) parts.push(str(o.username));
  if (o.password !== undefined) parts.push(bin(utf8Encode(o.password)));
  return packet(1, 0, concatBytes(...parts));
}

export function publishPacket(topic: string, payload: Uint8Array, qos: 0 | 1, packetId: number): Uint8Array {
  const parts: Uint8Array[] = [str(topic)];
  if (qos > 0) parts.push(new Uint8Array([packetId >> 8, packetId & 0xff]));
  parts.push(payload);
  return packet(3, qos << 1, concatBytes(...parts));
}

export function subscribePacket(topics: string[], packetId: number): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([packetId >> 8, packetId & 0xff])];
  for (const topic of topics) parts.push(str(topic), new Uint8Array([0]));
  return packet(8, 0x02, concatBytes(...parts));
}

export class MqttClient {
  private decoder = new PacketDecoder();
  private nextId = 1;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private onMessage: (topic: string, payload: Uint8Array) => void = () => {};
  private onClose: (error: string | null) => void = () => {};
  private subAcks = new Map<number, () => void>();

  private constructor(private conn: Connection) {}

  static async connect(transport: Transport, options: MqttOptions): Promise<MqttClient> {
    const timeoutMs = options.timeoutMs ?? 6000;
    const conn = await transport.connect(options.host, options.port, timeoutMs, options.mode);
    const client = new MqttClient(conn);
    return new Promise<MqttClient>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        conn.close();
        reject(error);
      };
      const timer = setTimeout(() => fail(new MqttError('La tele no respondió (timeout MQTT)')), timeoutMs);
      conn.setHandlers(
        (data) => {
          for (const p of client.decoder.push(data)) {
            if (!settled) {
              if (p.type !== 2) continue; // waiting for CONNACK
              const code = p.body[1] ?? 0;
              if (code !== 0) return fail(new MqttError(`La tele rechazó la conexión MQTT (código ${code})`, code));
              settled = true;
              clearTimeout(timer);
              client.startPing(options.keepAliveSec ?? 30);
              resolve(client);
            } else {
              client.handle(p);
            }
          }
        },
        (error) => {
          if (!settled) fail(new MqttError(error ?? 'La tele cerró la conexión MQTT'));
          else client.finish(error);
        },
      );
      conn.write(connectPacket(options));
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  setHandlers(onMessage: (topic: string, payload: Uint8Array) => void, onClose: (error: string | null) => void) {
    this.onMessage = onMessage;
    this.onClose = onClose;
  }

  /** Subscribes and waits for the broker's SUBACK (or the timeout). */
  subscribe(topics: string[], timeoutMs = 3000): Promise<void> {
    const id = this.allocateId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.subAcks.delete(id);
        resolve();
      }, timeoutMs);
      this.subAcks.set(id, () => {
        clearTimeout(timer);
        resolve();
      });
      this.conn.write(subscribePacket(topics, id));
    });
  }

  publish(topic: string, payload: string | Uint8Array = '', qos: 0 | 1 = 0) {
    if (this.closed) return;
    const bytes = typeof payload === 'string' ? utf8Encode(payload) : payload;
    this.conn.write(publishPacket(topic, bytes, qos, qos ? this.allocateId() : 0));
  }

  close() {
    if (this.closed) return;
    try {
      this.conn.write(packet(14, 0, new Uint8Array(0))); // DISCONNECT
    } catch {
      // closing anyway
    }
    this.conn.close();
    this.finish(null);
  }

  private allocateId(): number {
    const id = this.nextId;
    this.nextId = this.nextId >= 0xffff ? 1 : this.nextId + 1;
    return id;
  }

  private startPing(keepAliveSec: number) {
    if (keepAliveSec <= 0) return;
    this.pingTimer = setInterval(() => {
      if (!this.closed) this.conn.write(packet(12, 0, new Uint8Array(0)));
    }, Math.max(5, keepAliveSec / 2) * 1000);
  }

  private handle(p: MqttPacket) {
    switch (p.type) {
      case 3: {
        // PUBLISH
        const topicLength = (p.body[0] << 8) | p.body[1];
        const topic = utf8Decode(p.body.subarray(2, 2 + topicLength));
        const qos = (p.flags >> 1) & 3;
        let offset = 2 + topicLength;
        if (qos > 0) {
          const id = (p.body[offset] << 8) | p.body[offset + 1];
          offset += 2;
          this.conn.write(packet(4, 0, new Uint8Array([id >> 8, id & 0xff]))); // PUBACK
        }
        this.onMessage(topic, p.body.subarray(offset));
        break;
      }
      case 9: {
        // SUBACK
        const id = (p.body[0] << 8) | p.body[1];
        this.subAcks.get(id)?.();
        this.subAcks.delete(id);
        break;
      }
      default:
        break;
    }
  }

  private finish(error: string | null) {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.onClose(error);
  }
}
