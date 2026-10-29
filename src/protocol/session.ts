// Remote session (port 6466): handshake, keep-alive, and sending keys and text.

import { Feature, KeyCode, OUR_FEATURES, parseRemote, remote, type TextFieldStatus } from './messages';
import { Deframer, frame } from './pb';
import { isCertificateRejection, type Connection, type Transport } from './transport';

export const REMOTE_PORT = 6466;
const SILENCE_TIMEOUT_MS = 16_000;

/** Why a session ended: the TV doesn't know this phone, the network failed, or we closed it. */
export type CloseReason = 'needs_pairing' | 'network' | 'closed';

export type SessionEvents = {
  onReady?: () => void;
  onClose?: (reason: CloseReason, detail: string | null) => void;
  /** Package of the app in front on the TV (e.g. com.google.android.youtube.tv). */
  onApp?: (appPackage: string) => void;
  /** The TV opened a text field and would show a keyboard. */
  onTextField?: (field: TextFieldStatus | null) => void;
  onDebug?: (line: string) => void;
};

export class RemoteSession {
  ready = false;
  closed = false;
  closeReason: CloseReason | null = null;
  currentApp = '';
  private features: number = OUR_FEATURES;
  private imeCounter = 0;
  private fieldCounter = 0;
  private gotAnyMessage = false;
  private deframer = new Deframer();
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    private conn: Connection,
    private events: SessionEvents,
  ) {
    this.resetSilenceTimer();
    conn.setHandlers(
      (data) => this.onData(data),
      (error) => this.onClosed(error),
    );
  }

  /**
   * The TV pings every 5 s. If it goes quiet (Wi-Fi dropped without closing the socket),
   * give up after 16 s like the reference client does, so the app reconnects.
   */
  private resetSilenceTimer() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      if (this.closed) return;
      this.finish('network', 'no messages from the TV');
      this.conn.close();
    }, SILENCE_TIMEOUT_MS);
  }

  /** Throws TransportError if the TV can't be reached (or refuses the certificate right away). */
  static async open(transport: Transport, host: string, events: SessionEvents): Promise<RemoteSession> {
    const conn = await transport.connect(host, REMOTE_PORT, 5000);
    return new RemoteSession(conn, events);
  }

  sendKey(keyCode: number) {
    this.send(remote.key(keyCode));
  }

  sendText(text: string) {
    if (!text) return;
    this.send(remote.imeText(text, this.imeCounter, this.fieldCounter));
  }

  sendDeletes(count: number) {
    for (let i = 0; i < count; i++) this.sendKey(KeyCode.DEL);
  }

  openLink(link: string) {
    this.send(remote.appLink(link));
  }

  close() {
    if (this.closed) return;
    this.finish('closed', null);
    this.conn.close();
  }

  private send(message: Uint8Array) {
    if (this.closed) return;
    this.conn.write(frame(message));
  }

  private onData(data: Uint8Array) {
    let messages: Uint8Array[];
    try {
      messages = this.deframer.push(data);
    } catch {
      this.close();
      return;
    }
    if (messages.length) this.resetSilenceTimer();
    for (const raw of messages) {
      this.gotAnyMessage = true;
      try {
        const msg = parseRemote(raw);
        if (msg.kind !== 'ping') this.events.onDebug?.(`<- ${JSON.stringify(msg)}`);
        switch (msg.kind) {
          case 'configure':
            this.features = OUR_FEATURES & (msg.features || OUR_FEATURES);
            if (!(this.features & Feature.IME)) this.events.onDebug?.('TV did not grant IME');
            this.send(remote.configure(this.features));
            break;
          case 'set_active':
            this.send(remote.setActive(this.features));
            // Some TVs don't send remote_start; be ready shortly after anyway.
            this.readyTimer = setTimeout(() => this.markReady(), 400);
            break;
          case 'start':
            this.markReady();
            break;
          case 'ping':
            this.send(remote.pingResponse(msg.val1));
            break;
          case 'ime_key_inject':
            if (msg.appPackage && msg.appPackage !== this.currentApp) {
              this.currentApp = msg.appPackage;
              this.events.onApp?.(msg.appPackage);
            }
            if (msg.field) this.events.onTextField?.(msg.field);
            break;
          case 'ime_batch_edit':
            this.imeCounter = msg.imeCounter;
            this.fieldCounter = msg.fieldCounter;
            break;
          case 'ime_show_request':
            this.events.onTextField?.(msg.field);
            break;
          default:
            break;
        }
      } catch {
        // A malformed or out-of-range message (e.g. a ping with an oversized varint, which would
        // throw while building the response) must not take down the socket callback.
        continue;
      }
    }
  }

  private markReady() {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    if (this.ready || this.closed) return;
    this.ready = true;
    this.events.onReady?.();
  }

  private onClosed(error: string | null) {
    if (this.closed) return;
    // A refused certificate shows up as an error right after connecting, before any message.
    const reason: CloseReason =
      !this.gotAnyMessage && isCertificateRejection(error) ? 'needs_pairing' : 'network';
    this.finish(reason, error);
  }

  private finish(reason: CloseReason, detail: string | null) {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.closeReason = reason;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.events.onClose?.(reason, detail);
  }
}
