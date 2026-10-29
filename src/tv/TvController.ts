// Keeps the phone connected to the TV, mirrors the text box into the TV's text field,
// and runs searches in the app picked in the selector.
// UI-agnostic: the screen calls setText/submit/setTarget and renders getState().

import { KeyCode } from '../protocol/messages';
import { PairingError, PairingSession } from '../protocol/pairing';
import { RemoteSession, type CloseReason } from '../protocol/session';
import { diffText, needsAsciiOnly, textForTv } from '../protocol/textSync';
import { isCertificateRejection, TransportError, type DiscoveredTv, type Transport } from '../protocol/transport';
import { appById, asciiOnlyFor, autoTarget, DEFAULT_TARGET, type SearchApp, type TargetId } from './apps';

const CLIENT_NAME = 'Teclado TV';
/** While connected, the TV's own on-screen keyboard is replaced by the bridge, so let go when idle. */
const IDLE_DISCONNECT_MS = 3 * 60_000;
/** After this long in the background, start with an empty box. */
const FORGET_TEXT_AFTER_MS = 60_000;

export const DEFAULT_TIMING = {
  /** Right after connecting, the TV switches to its keyboard bridge; input sent before that is lost. */
  warmUpMs: 700,
  /**
   * For apps whose search link can't carry the text: type it once the search screen is up.
   * There's no signal for that, so it's typed a few times (clearing the previous try first).
   * HBO Max: ~3 s to reload its search when already open, up to ~20 s on a cold start.
   * Deletes and letters sent together get mixed up in Max, hence the gap between them.
   */
  searchScreen: {
    alreadyOpenMs: [3500, 8000],
    justOpenedMs: [5000, 12_000, 20_000],
    retypeGapMs: 1500,
    giveUpMs: 25_000,
  },
};

export type ConnectionState = 'connecting' | 'ready' | 'idle' | 'offline';
export type PairingPhase = 'requesting' | 'waiting_code' | 'checking' | 'failed';

export type TvState = {
  connection: ConnectionState;
  pairing: { phase: PairingPhase; error: string | null } | null;
  /** Address of the chosen TV. Empty until one is chosen (first run). */
  host: string;
  /** Name the TV announces on the Wi-Fi (e.g. "serri tv"). */
  tvName: string;
  /** No TV chosen yet: the screen shows the list of TVs found on the Wi-Fi. */
  needsTv: boolean;
  /** TVs found on the Wi-Fi. */
  scan: { scanning: boolean; tvs: DiscoveredTv[] };
  /** App in front on the TV, e.g. com.google.android.youtube.tv. Empty if unknown. */
  tvApp: string;
  /** Changes whenever the text box should be emptied (search sent, TV switched apps…). */
  clearToken: number;
  /** Where "Buscar" searches. Follows the app open on the TV unless the user picked one. */
  target: TargetId;
  /** False while the user's own pick is in effect (until the TV changes app). */
  targetAuto: boolean;
};

export interface SettingsStore {
  get(key: string): string | null;
  set(key: string, value: string | null): void;
}

type PendingAction = { kind: 'submit'; text: string; target: TargetId };

export class TvController {
  private state: TvState;
  private listeners = new Set<(state: TvState) => void>();
  private active = false;
  private session: RemoteSession | null = null;
  private opening = false;
  private canSend = false;
  private failures = 0;
  private pairingSession: PairingSession | null = null;
  private pairingBusy = false;
  private phoneText = '';
  private tvText = '';
  private lastApp = '';
  private pending: PendingAction[] = [];
  private backgroundSince = 0;
  private warmTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private afterOpen: { app: SearchApp; text: string } | null = null;
  private afterOpenTimers: ReturnType<typeof setTimeout>[] = [];
  /** Set while an app we opened is coming to the front, so the text box isn't cleared. */
  private keepTextFor: SearchApp | null = null;
  private scanning: Promise<DiscoveredTv[]> | null = null;

  constructor(
    private transport: Transport & { resetClientKey?: () => Promise<void> },
    private store: SettingsStore,
    private timing = DEFAULT_TIMING,
  ) {
    const host = store.get('host') || '';
    this.state = {
      connection: 'connecting',
      pairing: null,
      host,
      tvName: store.get('tvName') || host,
      needsTv: !host,
      scan: { scanning: false, tvs: [] },
      tvApp: '',
      clearToken: 0,
      target: DEFAULT_TARGET,
      targetAuto: true,
    };
  }

  getState(): TvState {
    return this.state;
  }

  subscribe(listener: (state: TvState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Call with true when the app is on screen, false when it goes to the background. */
  setActive(active: boolean) {
    if (active === this.active) return;
    this.active = active;
    if (active) {
      if (this.backgroundSince && Date.now() - this.backgroundSince > FORGET_TEXT_AFTER_MS) this.clearText();
      this.failures = 0;
      if (this.state.host) this.connect();
      else void this.findFirstTv();
    } else {
      this.backgroundSince = Date.now();
      this.clearTimers();
      this.closeSession();
      this.pairingSession?.cancel();
      this.pairingSession = null;
      this.update({ connection: 'connecting', pairing: null });
    }
  }

  /** The text box changed. Only the difference is typed on the TV. */
  setText(text: string) {
    this.phoneText = text;
    // The user is typing again: stop re-typing the last search.
    this.cancelAfterOpen();
    this.sync();
  }

  /** "Buscar": opens the selected app's search with the text, or types it and presses Enter. */
  submit() {
    this.pending.push({ kind: 'submit', text: this.phoneText, target: this.state.target });
    // Apps that only open keep the text, to type it once their search is on screen.
    if (!appById(this.state.target)?.opensOnly) {
      this.phoneText = '';
      this.update({ clearToken: this.state.clearToken + 1 });
    }
    this.sync();
  }

  /** The user picked where to search. Holds until the TV changes app. */
  setTarget(target: TargetId) {
    this.update({ target, targetAuto: false });
    this.sync();
  }

  /** Looks for TVs on the Wi-Fi. Results land in state.scan. */
  scanTvs(): Promise<DiscoveredTv[]> {
    if (this.scanning) return this.scanning;
    const discover = this.transport.discover;
    if (!discover) return Promise.resolve([]);
    this.update({ scan: { scanning: true, tvs: this.state.scan.tvs } });
    this.scanning = discover
      .call(this.transport, 3500)
      .catch(() => [] as DiscoveredTv[])
      .then((found) => {
        const byHost = new Map(found.map((tv) => [tv.host, tv]));
        const tvs = [...byHost.values()].sort((a, b) => a.name.localeCompare(b.name));
        this.scanning = null;
        this.update({ scan: { scanning: false, tvs } });
        return tvs;
      });
    return this.scanning;
  }

  /** Connect to this TV from now on (pairs first if it doesn't know this phone yet). */
  chooseTv(tv: DiscoveredTv) {
    const host = tv.host.trim();
    if (!host) return;
    const name = tv.name.trim() || host;
    this.store.set('host', host);
    this.store.set('tvName', name);
    this.update({ host, tvName: name, needsTv: false });
    this.restart();
  }

  /** Forget this phone's certificate and pair again. */
  async pairAgain() {
    this.closeSession();
    await this.transport.resetClientKey?.();
    this.restart();
  }

  async submitCode(code: string) {
    const pairing = this.pairingSession;
    if (!pairing) return;
    this.update({ pairing: { phase: 'checking', error: null } });
    try {
      await pairing.finish(code);
      this.pairingSession = null;
      this.failures = 0;
      this.update({ pairing: null, connection: 'connecting' });
      this.connect();
    } catch (e) {
      if (e instanceof PairingError && e.code === 'bad_code') {
        this.update({ pairing: { phase: 'waiting_code', error: 'Ese código no coincide. Fijate en la tele y probá de nuevo.' } });
      } else {
        this.pairingSession = null;
        this.update({ pairing: { phase: 'failed', error: 'La tele no aceptó el código. Pedí uno nuevo.' } });
      }
    }
  }

  requestNewCode() {
    this.pairingSession?.cancel();
    this.pairingSession = null;
    void this.startPairing();
  }

  // ---------- internals ----------

  private update(patch: Partial<TvState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private restart() {
    this.clearTimers();
    this.closeSession();
    this.pairingSession?.cancel();
    this.pairingSession = null;
    this.failures = 0;
    this.update({ connection: 'connecting', pairing: null });
    this.connect();
  }

  /** Type into the TV as you go only when the text is for the app that's open (or for "Enter"). */
  private typesLive(): boolean {
    const { target, tvApp } = this.state;
    return target === 'enter' || !!appById(target)?.packages.includes(tvApp);
  }

  private clearText() {
    this.phoneText = '';
    this.tvText = '';
    this.pending = [];
    this.update({ clearToken: this.state.clearToken + 1 });
  }

  /** First run: use the TV right away if there's only one on the Wi-Fi; otherwise let the user pick. */
  private async findFirstTv() {
    const tvs = await this.scanTvs();
    if (!this.state.host && tvs.length === 1) this.chooseTv(tvs[0]);
  }

  private async connect() {
    if (!this.state.host) return;
    if (!this.active || this.session || this.opening || this.pairingSession || this.pairingBusy) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.opening = true;
    let session: RemoteSession | null = null;
    try {
      session = await RemoteSession.open(this.transport, this.state.host, {
        onReady: () => {
          if (session && this.session === session) this.onReady();
        },
        onClose: (reason) => {
          if (session && this.session === session) {
            this.session = null;
            this.onLost(reason);
          }
        },
        onApp: (app) => this.onTvApp(app),
      });
    } catch (e) {
      this.opening = false;
      const refused = e instanceof TransportError && e.code === 'tls' && isCertificateRejection(e.message);
      this.onLost(refused ? 'needs_pairing' : 'network');
      return;
    }
    this.opening = false;
    if (!this.active) {
      session.close();
      return;
    }
    if (session.closed) {
      this.onLost(session.closeReason ?? 'network');
      return;
    }
    this.session = session;
    if (session.currentApp) this.onTvApp(session.currentApp);
    if (session.ready) this.onReady();
  }

  private onReady() {
    this.failures = 0;
    this.update({ connection: 'ready', pairing: null });
    if (this.warmTimer) clearTimeout(this.warmTimer);
    this.warmTimer = setTimeout(() => {
      this.warmTimer = null;
      this.canSend = true;
      this.sync();
    }, this.timing.warmUpMs);
    this.touchIdle();
  }

  private onLost(reason: CloseReason) {
    this.canSend = false;
    if (this.warmTimer) clearTimeout(this.warmTimer);
    this.warmTimer = null;
    if (!this.active || reason === 'closed') return;
    if (reason === 'needs_pairing') {
      void this.startPairing();
      return;
    }
    this.failures++;
    this.update({ connection: this.failures >= 2 ? 'offline' : 'connecting' });
    // The TV may have a new address (it changes when the router hands out another one).
    if (this.failures === 1 || this.failures % 5 === 0) void this.rediscover();
    this.retryTimer = setTimeout(() => this.connect(), Math.min(1000 * this.failures, 5000));
  }

  private onTvApp(app: string) {
    if (!app || app === this.state.tvApp) return;
    const opening = this.keepTextFor;
    this.keepTextFor = null;
    if (opening?.packages.includes(app)) {
      // We opened this app on purpose: keep the text for its search field, which starts empty.
      this.tvText = '';
    } else if (this.lastApp && app !== this.lastApp) {
      // A different app means a different text field: what we typed before doesn't apply.
      this.clearText();
    }
    this.lastApp = app;
    // The selector follows the TV: a new app on screen replaces the user's earlier pick.
    this.update({ tvApp: app, target: autoTarget(app), targetAuto: true });
    if (this.afterOpen?.app.packages.includes(app)) this.typeAfterOpen(this.timing.searchScreen.justOpenedMs);
  }

  /** Sends whatever is needed so the TV field matches the phone box. */
  private sync() {
    const session = this.session;
    if (!session || !session.ready || !this.canSend) {
      if (!session && this.active) {
        if (this.state.connection === 'idle') this.update({ connection: 'connecting' });
        this.connect();
      }
      return;
    }
    const asciiOnly = needsAsciiOnly(this.state.tvApp) || asciiOnlyFor(this.state.tvApp);
    for (const action of this.pending.splice(0)) this.search(session, action, asciiOnly);
    if (this.typesLive()) this.typeDiff(session, textForTv(this.phoneText, asciiOnly));
    this.touchIdle();
  }

  private search(session: RemoteSession, action: PendingAction, asciiOnly: boolean) {
    const app = appById(action.target);
    const text = action.text.trim();
    if (app?.opensOnly) {
      // Open the app if needed. Once it's open, the live typing in sync() puts the text in its field.
      if (!app.packages.includes(this.state.tvApp)) {
        this.keepTextFor = app;
        session.openLink(app.searchLink(text));
      }
      return;
    }
    if (!app) {
      // Any other app: finish typing in its field and press Enter.
      this.typeDiff(session, textForTv(action.text, asciiOnly));
      session.sendKey(KeyCode.ENTER);
    } else {
      // Opening the link brings the app to the front (switching apps if needed).
      session.openLink(app.searchLink(text));
      if (app.typeAfterOpen && text) {
        this.cancelAfterOpen();
        this.afterOpen = { app, text };
        if (app.packages.includes(this.state.tvApp)) this.typeAfterOpen(this.timing.searchScreen.alreadyOpenMs);
        else this.afterOpenTimers.push(setTimeout(() => this.cancelAfterOpen(), this.timing.searchScreen.giveUpMs));
      }
    }
    // The field on the TV now holds a submitted search, not what we're typing next.
    this.tvText = '';
  }

  /** Types the search at each delay, deleting what the previous try left (if it landed). */
  private typeAfterOpen(delaysMs: number[]) {
    const pending = this.afterOpen;
    if (!pending) return;
    for (const timer of this.afterOpenTimers) clearTimeout(timer);
    this.afterOpenTimers = [];
    const text = textForTv(pending.text, !!pending.app.asciiOnly);
    const length = Array.from(text).length;
    const gapMs = this.timing.searchScreen.retypeGapMs;
    const typeText = (last: boolean) => {
      if (this.session?.ready) this.session.sendText(text);
      if (last) this.cancelAfterOpen();
    };
    delaysMs.forEach((delayMs, i) => {
      const last = i === delaysMs.length - 1;
      this.afterOpenTimers.push(
        setTimeout(() => {
          if (i === 0) return typeText(last);
          // Clear what an earlier try left, give the app time to process it, then type again.
          this.session?.sendDeletes(length);
          this.afterOpenTimers.push(setTimeout(() => typeText(last), gapMs));
        }, delayMs),
      );
    });
  }

  private cancelAfterOpen() {
    for (const timer of this.afterOpenTimers) clearTimeout(timer);
    this.afterOpenTimers = [];
    this.afterOpen = null;
  }

  private typeDiff(session: RemoteSession, target: string) {
    const { deletes, insert } = diffText(this.tvText, target);
    session.sendDeletes(deletes);
    session.sendText(insert);
    this.tvText = target;
  }

  private touchIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.closeSession();
      if (this.active) this.update({ connection: 'idle' });
    }, IDLE_DISCONNECT_MS);
  }

  private async startPairing() {
    if (this.pairingSession || this.pairingBusy || !this.active) return;
    this.pairingBusy = true;
    this.update({ connection: 'connecting', pairing: { phase: 'requesting', error: null } });
    try {
      const pairing = await PairingSession.start(this.transport, this.state.host, CLIENT_NAME);
      if (!this.active) {
        pairing.cancel();
        return;
      }
      this.pairingSession = pairing;
      const onTvClosed = () => {
        if (this.pairingSession !== pairing) return;
        this.pairingSession = null;
        this.update({ pairing: { phase: 'failed', error: 'Se cerró el código en la tele.' } });
      };
      pairing.onClose(onTvClosed);
      this.update({ pairing: { phase: 'waiting_code', error: null } });
      if (pairing.isClosed) onTvClosed();
    } catch {
      this.update({ pairing: { phase: 'failed', error: 'No pude pedirle el código a la tele. ¿Está prendida?' } });
    } finally {
      this.pairingBusy = false;
    }
  }

  /** The TV stopped answering: if it's on the Wi-Fi at another address (same name), follow it. */
  private async rediscover() {
    const found = await this.scanTvs();
    if (!found.length || found.some((tv) => tv.host === this.state.host)) return;
    const same = found.find((tv) => tv.name === this.state.tvName) ?? (found.length === 1 ? found[0] : undefined);
    if (!same) return;
    this.store.set('host', same.host);
    this.store.set('tvName', same.name);
    this.update({ host: same.host, tvName: same.name });
    this.failures = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connect();
  }

  private closeSession() {
    const session = this.session;
    this.session = null;
    this.canSend = false;
    session?.close();
  }

  private clearTimers() {
    for (const timer of [this.warmTimer, this.retryTimer, this.idleTimer]) if (timer) clearTimeout(timer);
    this.warmTimer = this.retryTimer = this.idleTimer = null;
    this.cancelAfterOpen();
  }
}
