// Pairing (port 6467): the TV shows a 6-character code and we prove we saw it.
// Done once per phone; afterwards the TV accepts this phone's certificate on port 6466.

import { concatBytes, hexToBytes, stripLeadingZeros } from './bytes';
import { POLO_STATUS_OK, parsePolo, polo } from './messages';
import { Deframer, frame } from './pb';
import { sha256 } from './sha256';
import type { Connection, PublicKey, Transport } from './transport';

export const PAIRING_PORT = 6467;
const STEP_TIMEOUT_MS = 10_000;

export class PairingError extends Error {
  constructor(
    message: string,
    readonly code: 'bad_code' | 'rejected' | 'closed' | 'timeout',
  ) {
    super(message);
  }
}

export function isValidCode(code: string): boolean {
  return /^[0-9a-f]{6}$/i.test(code);
}

/** The pairing secret: SHA-256 over both public keys and the last 4 code characters. */
export function pairingSecret(client: PublicKey, server: PublicKey, code: string): Uint8Array {
  return sha256(
    concatBytes(
      stripLeadingZeros(client.modulus),
      stripLeadingZeros(client.exponent),
      stripLeadingZeros(server.modulus),
      stripLeadingZeros(server.exponent),
      hexToBytes(code.slice(2)),
    ),
  );
}

type Waiter = { kind: string; resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class PairingSession {
  private deframer = new Deframer();
  private waiter: Waiter | null = null;
  private closed = false;
  private closeListener: (() => void) | null = null;

  private constructor(
    private conn: Connection,
    private clientKey: PublicKey,
  ) {
    conn.setHandlers(
      (data) => this.onData(data),
      () => this.onClosed(),
    );
  }

  /** Connects and asks the TV to show a code. Resolves once the code is on screen. */
  static async start(transport: Transport, host: string, clientName: string): Promise<PairingSession> {
    const clientKey = await transport.getClientKey();
    const conn = await transport.connect(host, PAIRING_PORT, 5000);
    const session = new PairingSession(conn, clientKey);
    const shown = session.waitFor('configuration_ack');
    session.send(polo.pairingRequest(clientName));
    try {
      await shown;
    } catch (e) {
      session.cancel();
      throw e;
    }
    return session;
  }

  get isClosed() {
    return this.closed;
  }

  /** Called if the TV closes the pairing screen (for example, Cancel on the TV). */
  onClose(listener: () => void) {
    this.closeListener = listener;
  }

  /** Sends the code the user typed. Throws PairingError('bad_code') if it doesn't match. */
  async finish(code: string): Promise<void> {
    const clean = code.trim().toUpperCase();
    if (!isValidCode(clean)) throw new PairingError('El código tiene 6 caracteres (0-9 y A-F).', 'bad_code');
    if (this.closed) throw new PairingError('La tele cerró la vinculación.', 'closed');
    const secret = pairingSecret(this.clientKey, this.conn.serverKey, clean);
    // The first byte of the secret must match the first two code characters.
    // A mismatch means a typo, so we don't send anything and let the user retry.
    if (secret[0] !== parseInt(clean.slice(0, 2), 16)) {
      throw new PairingError('Ese código no coincide.', 'bad_code');
    }
    const acked = this.waitFor('secret_ack');
    this.send(polo.secret(secret));
    await acked;
    this.cancel();
  }

  cancel() {
    if (this.closed) return;
    this.closed = true;
    this.conn.close();
  }

  private send(message: Uint8Array) {
    this.conn.write(frame(message));
  }

  private waitFor(kind: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new PairingError('La tele no respondió.', 'timeout'));
      }, STEP_TIMEOUT_MS);
      this.waiter = { kind, resolve, reject, timer };
    });
  }

  private settle(error: Error | null, kind?: string) {
    const w = this.waiter;
    if (!w) return;
    if (!error && w.kind !== kind) return;
    clearTimeout(w.timer);
    this.waiter = null;
    if (error) w.reject(error);
    else w.resolve();
  }

  private onData(data: Uint8Array) {
    let frames: Uint8Array[];
    try {
      frames = this.deframer.push(data);
    } catch {
      // A corrupt byte stream from the TV must not crash the socket callback: end the pairing.
      this.settle(new PairingError('La tele mandó datos inválidos.', 'closed'));
      this.cancel();
      return;
    }
    for (const raw of frames) {
      let msg;
      try {
        msg = parsePolo(raw);
      } catch {
        // Skip a single malformed message instead of throwing; the step timeout still guards us.
        continue;
      }
      if (msg.status !== POLO_STATUS_OK) {
        this.settle(new PairingError(`La tele rechazó la vinculación (${msg.status}).`, 'rejected'));
        this.cancel();
        return;
      }
      switch (msg.kind) {
        case 'pairing_request_ack':
          this.send(polo.options());
          break;
        case 'options':
          this.send(polo.configuration());
          break;
        case 'configuration_ack':
        case 'secret_ack':
          this.settle(null, msg.kind);
          break;
        default:
          break;
      }
    }
  }

  private onClosed() {
    const wasOpen = !this.closed;
    this.closed = true;
    this.settle(new PairingError('La tele cerró la vinculación.', 'closed'));
    if (wasOpen) this.closeListener?.();
  }
}
