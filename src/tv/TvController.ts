// Keeps the phone connected to the TV, mirrors the text box into the TV's text field,
// and (Android TV) runs searches in the app picked in the selector.
// Brand-agnostic: each TV brand is a connector in src/brands. UI-agnostic: the screen calls
// setText/submit/setTarget and renders getState().

import { DRIVERS, driverFor } from '../brands';
import { discoverTvs, identifyHost } from '../brands/discovery';
import {
  PairingError,
  PairingRequired,
  TvSetupNeeded,
  type CloseReason,
  type Credentials,
  type Driver,
  type DriverContext,
  type PairingFlow,
  type PairingPrompt,
  type TvInfo,
  type TvSession,
} from '../brands/types';
import { needsAsciiOnly, textForTv } from '../protocol/textSync';
import type { Transport } from '../protocol/transport';
import { appById, asciiOnlyFor, autoTarget, DEFAULT_TARGET, type SearchApp, type TargetId } from './apps';

const CLIENT_NAME = 'Teclado TV';
/** While connected, Android TV's own on-screen keyboard is replaced by the bridge, so let go when idle. */
const IDLE_DISCONNECT_MS = 3 * 60_000;
/** After this long in the background, start with an empty box. */
const FORGET_TEXT_AFTER_MS = 60_000;

export const DEFAULT_TIMING = {
  /** Wait after connecting before typing. Undefined: what the brand's connector asks for. */
  warmUpMs: undefined as number | undefined,
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

export type Timing = {
  warmUpMs?: number;
  searchScreen: typeof DEFAULT_TIMING.searchScreen;
};

export type ConnectionState = 'connecting' | 'ready' | 'idle' | 'offline';
export type PairingPhase = 'requesting' | 'waiting_code' | 'waiting_accept' | 'checking' | 'failed';

export type TvState = {
  connection: ConnectionState;
  pairing: { phase: PairingPhase; error: string | null; prompt: PairingPrompt | null } | null;
  /** The chosen TV. Null until one is chosen (first run). */
  tv: TvInfo | null;
  /** Address of the chosen TV. Empty until one is chosen. */
  host: string;
  /** Name the TV announces on the Wi-Fi (e.g. "serri tv"). */
  tvName: string;
  /** "Android TV", "Samsung"… */
  brandLabel: string;
  /** No TV chosen yet: the screen shows the list of TVs found on the Wi-Fi. */
  needsTv: boolean;
  /** TVs found on the Wi-Fi. `deep` while probing every address. */
  scan: { scanning: boolean; deep: boolean; tvs: TvInfo[] };
  /** The TV can search inside apps (Android TV): show the app selector. */
  appLinks: boolean;
  /** The TV only takes added text: the box is a draft sent with "Enviar" (no live typing). */
  compose: boolean;
  /** This TV reports its keyboard open/closed; typing waits until it's open. */
  reportsKeyboard: boolean;
  /** The phone can press Enter on the TV. */
  canSubmit: boolean;
  /** Something on the TV blocks the phone (a setting to change); shown instead of the usual hint. */
  problem: string | null;
  /** The TV says whether its keyboard is open (null: this TV doesn't tell). */
  tvKeyboard: boolean | null;
  /** Text the TV field already has: the box should show it (changes `token` each time). */
  remoteText: { token: number; text: string } | null;
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

/** `submit`: Buscar / Enter. `send`: draft for append-only TVs. `enter`: just the Enter key. */
type PendingAction = { kind: 'submit' | 'send' | 'enter'; text: string; target: TargetId };

const isIp = (text: string) => /^\d+\.\d+\.\d+\.\d+$/.test(text);

function loadTv(store: SettingsStore): TvInfo | null {
  const saved = store.get('tv');
  if (saved) {
    try {
      const tv = JSON.parse(saved) as TvInfo;
      if (tv.host && tv.brand) return tv;
    } catch {
      // fall through to the older format
    }
  }
  // Version 1 only knew Android TVs and saved host + name.
  const host = store.get('host');
  return host ? { brand: 'androidtv', host, name: store.get('tvName') || host } : null;
}

/** Credentials are kept per TV, by its stable id when it has one, so a new IP keeps the pairing. */
const credentialKey = (tv: TvInfo) => `cred:${tv.brand}:${tv.id || tv.name || tv.host}`;

export class TvController {
  private state: TvState;
  private listeners = new Set<(state: TvState) => void>();
  private active = false;
  private session: TvSession | null = null;
  private opening = false;
  private canSend = false;
  private failures = 0;
  private pairingFlow: PairingFlow | null = null;
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
  private scanning: Promise<TvInfo[]> | null = null;
  /** Bumps on every connect attempt, so late answers from an older attempt are ignored. */
  private attempt = 0;
  private ctx: DriverContext;

  constructor(
    private transport: Transport & { resetClientKey?: () => Promise<void> },
    private store: SettingsStore,
    private timing: Timing = DEFAULT_TIMING,
    private drivers: Driver[] = DRIVERS,
  ) {
    this.ctx = { transport, clientName: CLIENT_NAME };
    const tv = loadTv(store);
    this.state = {
      connection: 'connecting',
      pairing: null,
      tv,
      host: tv?.host ?? '',
      tvName: tv?.name ?? '',
      brandLabel: tv ? (driverFor(tv.brand, drivers)?.label ?? '') : '',
      needsTv: !tv,
      scan: { scanning: false, deep: false, tvs: [] },
      appLinks: tv ? !!driverFor(tv.brand, drivers)?.appLinks : false,
      compose: tv ? driverFor(tv.brand, drivers)?.textMode === 'append' : false,
      reportsKeyboard: tv ? !!driverFor(tv.brand, drivers)?.reportsKeyboard : false,
      canSubmit: tv ? driverFor(tv.brand, drivers)?.canSubmit !== false : true,
      problem: null,
      tvKeyboard: null,
      remoteText: null,
      tvApp: '',
      clearToken: 0,
      target: tv && !driverFor(tv.brand, drivers)?.appLinks ? 'enter' : DEFAULT_TARGET,
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
      if (this.state.tv) this.connect();
      else void this.findFirstTv();
    } else {
      this.backgroundSince = Date.now();
      this.clearTimers();
      this.closeSession();
      this.cancelPairing();
      this.update({ connection: 'connecting', pairing: null });
    }
  }

  /** The text box changed. Only the difference is typed on the TV (or the whole text, for TVs that replace). */
  setText(text: string) {
    this.phoneText = text;
    // The user is typing again: stop re-typing the last search.
    this.cancelAfterOpen();
    this.sync();
  }

  /**
   * "Buscar" / "Enter": opens the selected app's search with the text, or types it and presses Enter.
   * For TVs that only take added text ("Enviar"): sends the draft, without pressing Enter.
   */
  submit() {
    const target = this.state.appLinks ? this.state.target : 'enter';
    if (this.state.compose) {
      if (!this.phoneText) return;
      this.pending.push({ kind: 'send', text: this.phoneText, target: 'enter' });
      this.phoneText = '';
      this.update({ clearToken: this.state.clearToken + 1 });
      this.sync();
      return;
    }
    this.pending.push({ kind: 'submit', text: this.phoneText, target });
    // Apps that only open keep the text, to type it once their search is on screen.
    if (!appById(target)?.opensOnly) {
      this.phoneText = '';
      this.update({ clearToken: this.state.clearToken + 1 });
    }
    this.sync();
  }

  /** Just the Enter key (for TVs where text is sent as a draft). */
  pressEnter() {
    this.pending.push({ kind: 'enter', text: '', target: 'enter' });
    this.sync();
  }

  /** The user picked where to search. Holds until the TV changes app. */
  setTarget(target: TargetId) {
    this.update({ target, targetAuto: false });
    this.sync();
  }

  /** Looks for TVs on the Wi-Fi. Results land in state.scan as they show up. */
  scanTvs(options: { deep?: boolean } = {}): Promise<TvInfo[]> {
    if (this.scanning) return this.scanning;
    const deep = !!options.deep;
    this.update({ scan: { scanning: true, deep, tvs: this.state.scan.tvs } });
    this.scanning = discoverTvs(this.ctx, this.drivers, {
      deep,
      onFound: (tvs) => this.update({ scan: { scanning: true, deep, tvs: mergeTvs(this.state.scan.tvs, tvs) } }),
    })
      .catch(() => [] as TvInfo[])
      .then((found) => {
        this.scanning = null;
        const tvs = deep || found.length ? found : this.state.scan.tvs;
        this.update({ scan: { scanning: false, deep: false, tvs } });
        return tvs;
      });
    return this.scanning;
  }

  /** Connect to this TV from now on (pairs first if it doesn't know this phone yet). */
  chooseTv(tv: TvInfo) {
    const host = tv.host.trim();
    if (!host) return;
    const chosen: TvInfo = { ...tv, host, name: tv.name.trim() || host };
    this.saveTv(chosen);
    const driver = driverFor(chosen.brand, this.drivers);
    this.update({
      needsTv: false,
      tvApp: '',
      appLinks: !!driver?.appLinks,
      compose: driver?.textMode === 'append',
      reportsKeyboard: !!driver?.reportsKeyboard,
      canSubmit: driver?.canSubmit !== false,
      problem: null,
      tvKeyboard: null,
      target: driver?.appLinks ? DEFAULT_TARGET : 'enter',
      targetAuto: true,
    });
    this.restart();
  }

  /** "Connect by address": find which brand answers there (Android TV if nothing does) and use it. */
  async chooseAddress(address: string): Promise<boolean> {
    const host = address.trim();
    if (!host) return false;
    const found = await identifyHost(this.ctx, this.drivers, host);
    this.chooseTv(found ?? { brand: 'androidtv', host, name: host });
    return !!found;
  }

  /** Forget this phone's pairing with the TV and pair again. */
  async pairAgain() {
    this.closeSession();
    const tv = this.state.tv;
    if (tv) this.store.set(credentialKey(tv), null);
    if (tv?.brand === 'androidtv') await this.transport.resetClientKey?.();
    this.restart();
  }

  async submitCode(code: string) {
    const flow = this.pairingFlow;
    if (!flow || flow.prompt.kind !== 'code' || !flow.submit) return;
    this.update({ pairing: { phase: 'checking', error: null, prompt: flow.prompt } });
    try {
      const saved = await flow.submit!(code);
      if (this.pairingFlow !== flow) return;
      this.pairingFlow = null;
      this.saveCredentials(saved);
      this.failures = 0;
      this.update({ pairing: null, connection: 'connecting' });
      this.connect();
    } catch (e) {
      if (this.pairingFlow !== flow) return;
      if (e instanceof PairingError && e.code === 'bad_code') {
        this.update({
          pairing: { phase: 'waiting_code', error: 'Ese código no coincide. Fijate en la tele y probá de nuevo.', prompt: flow.prompt },
        });
      } else {
        flow.cancel();
        this.pairingFlow = null;
        this.update({ pairing: { phase: 'failed', error: 'La tele no aceptó el código. Pedí uno nuevo.', prompt: flow.prompt } });
      }
    }
  }

  /** New code on the TV, or ask again to be allowed. */
  requestNewCode() {
    this.cancelPairing();
    if (this.state.pairing?.prompt?.kind === 'accept' || !driverFor(this.state.tv?.brand ?? 'androidtv', this.drivers)?.startPairing) {
      this.update({ pairing: null, connection: 'connecting' });
      this.failures = 0;
      this.connect();
    } else {
      void this.startPairing();
    }
  }

  // ---------- internals ----------

  private update(patch: Partial<TvState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private get driver(): Driver | undefined {
    return this.state.tv ? driverFor(this.state.tv.brand, this.drivers) : undefined;
  }

  private saveTv(tv: TvInfo) {
    this.store.set('tv', JSON.stringify(tv));
    this.store.set('host', null);
    this.store.set('tvName', null);
    this.update({
      tv,
      host: tv.host,
      tvName: tv.name,
      brandLabel: driverFor(tv.brand, this.drivers)?.label ?? '',
    });
  }

  private loadCredentials(): Credentials | null {
    const tv = this.state.tv;
    const saved = tv ? this.store.get(credentialKey(tv)) : null;
    if (!saved) return null;
    try {
      return JSON.parse(saved) as Credentials;
    } catch {
      return null;
    }
  }

  private saveCredentials(credentials: Credentials | undefined) {
    const tv = this.state.tv;
    if (!tv || !credentials || !Object.keys(credentials).length) return;
    this.store.set(credentialKey(tv), JSON.stringify({ ...(this.loadCredentials() ?? {}), ...credentials }));
  }

  private restart() {
    this.clearTimers();
    this.closeSession();
    this.cancelPairing();
    this.failures = 0;
    this.update({ connection: 'connecting', pairing: null });
    this.connect();
  }

  /** Type into the TV as you go only when the text is for the app that's open (or for "Enter"). */
  private typesLive(): boolean {
    if (this.state.compose) return false;
    // TVs that report keyboard state: only type while their keyboard is open.
    if (this.state.reportsKeyboard) return this.state.tvKeyboard === true;
    if (!this.state.appLinks) return true;
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
    let tvs = await this.scanTvs();
    if (!tvs.length && !this.state.tv) tvs = await this.scanTvs({ deep: true });
    if (!this.state.tv && tvs.length === 1) this.chooseTv(tvs[0]);
  }

  private async connect() {
    const tv = this.state.tv;
    const driver = this.driver;
    if (!tv || !driver) return;
    if (!this.active || this.session || this.opening || this.pairingFlow || this.pairingBusy) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.opening = true;
    const attempt = ++this.attempt;
    let session: TvSession | null = null;
    try {
      const target = driver.refine ? await driver.refine(tv, this.ctx).catch(() => tv) : tv;
      if (target !== tv && attempt === this.attempt) this.saveTv(target);
      const result = await driver.connect(
        target,
        this.loadCredentials(),
        {
          onClose: (reason) => {
            if (session && this.session === session) {
              this.session = null;
              this.onLost(reason);
            }
          },
          onApp: (app) => {
            if (attempt === this.attempt) this.onTvApp(app);
          },
          onKeyboard: (keyboard) => {
            if (attempt === this.attempt) this.onKeyboard(keyboard);
          },
          onPrompt: (prompt) => {
            if (attempt === this.attempt && this.active) {
              this.update({ connection: 'connecting', pairing: { phase: 'waiting_accept', error: null, prompt } });
            }
          },
        },
        this.ctx,
      );
      session = result.session;
      if (attempt !== this.attempt || !this.active) {
        // An older attempt (or the app went to the background): drop it.
        if (attempt === this.attempt) this.opening = false;
        session.close();
        return;
      }
      this.saveCredentials(result.saved);
    } catch (e) {
      if (attempt !== this.attempt) return;
      this.opening = false;
      if (e instanceof PairingRequired) return this.onLost('needs_pairing');
      if (e instanceof TvSetupNeeded) {
        // The TV answered but won't take commands until the user changes a setting: keep checking.
        this.update({ connection: 'offline', pairing: null, problem: e.message });
        this.retryTimer = setTimeout(() => this.connect(), 5000);
        return;
      }
      if (e instanceof PairingError) {
        // The user said no on the TV (or the prompt timed out).
        const prompt = this.state.pairing?.prompt ?? null;
        this.update({
          pairing: {
            phase: 'failed',
            error: e.code === 'rejected' ? 'La tele no dio permiso. Probá de nuevo y aceptá en la tele.' : 'No hubo respuesta en la tele.',
            prompt,
          },
        });
        return;
      }
      this.onLost('network');
      return;
    }
    this.opening = false;
    if (session.closed) {
      this.onLost('network');
      return;
    }
    this.session = session;
    if (this.state.pairing || this.state.problem) this.update({ pairing: null, problem: null });
    if (session.currentApp) this.onTvApp(session.currentApp);
    this.onReady(driver);
  }

  private onReady(driver: Driver) {
    this.failures = 0;
    this.update({ connection: 'ready', pairing: null });
    if (this.warmTimer) clearTimeout(this.warmTimer);
    this.warmTimer = setTimeout(() => {
      this.warmTimer = null;
      this.canSend = true;
      this.sync();
    }, this.timing.warmUpMs ?? driver.warmUpMs ?? 0);
    this.touchIdle();
  }

  private onLost(reason: CloseReason) {
    this.canSend = false;
    if (this.warmTimer) clearTimeout(this.warmTimer);
    this.warmTimer = null;
    // The TV field no longer holds what we typed (new connection, maybe a new field).
    this.tvText = '';
    if (this.state.tvKeyboard !== null) this.update({ tvKeyboard: null });
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
    if (this.state.appLinks) this.update({ tvApp: app, target: autoTarget(app), targetAuto: true });
    else this.update({ tvApp: app });
    if (this.afterOpen?.app.packages.includes(app)) this.typeAfterOpen(this.timing.searchScreen.justOpenedMs);
  }

  /** The TV opened/closed its keyboard, maybe telling us what its field holds. */
  private onKeyboard({ visible, text }: { visible: boolean; text?: string }) {
    const wasOpen = this.state.tvKeyboard;
    if (!visible) {
      // The field was confirmed or left: the next one starts empty.
      if (wasOpen) this.clearText();
      this.update({ tvKeyboard: false });
      return;
    }
    if (text !== undefined) {
      // The TV told us what its field holds: continue editing from there.
      this.tvText = text;
      this.phoneText = text;
      this.update({ remoteText: { token: (this.state.remoteText?.token ?? 0) + 1, text } });
    } else if (wasOpen !== true) {
      // Fresh field, contents unknown: assume empty so the phone text is (re)sent in full.
      this.tvText = '';
    }
    if (wasOpen !== true) this.update({ tvKeyboard: true });
    // The field is ready now: push whatever is already typed on the phone.
    if (this.phoneText) this.sync();
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

  private search(session: TvSession, action: PendingAction, asciiOnly: boolean) {
    if (action.kind === 'enter') {
      session.submit();
      return;
    }
    if (action.kind === 'send') {
      // Append-only TVs: the whole draft goes in at once.
      session.updateText('', textForTv(action.text, asciiOnly));
      this.tvText = '';
      return;
    }
    const app = appById(action.target);
    const text = action.text.trim();
    if (app && session.openLink) {
      if (app.opensOnly) {
        // Open the app if needed. Once it's open, the live typing in sync() puts the text in its field.
        if (!app.packages.includes(this.state.tvApp)) {
          this.keepTextFor = app;
          session.openLink(app.searchLink(text));
        }
        return;
      }
      // Opening the link brings the app to the front (switching apps if needed).
      session.openLink(app.searchLink(text));
      if (app.typeAfterOpen && text) {
        this.cancelAfterOpen();
        this.afterOpen = { app, text };
        if (app.packages.includes(this.state.tvApp)) this.typeAfterOpen(this.timing.searchScreen.alreadyOpenMs);
        else this.afterOpenTimers.push(setTimeout(() => this.cancelAfterOpen(), this.timing.searchScreen.giveUpMs));
      }
    } else {
      // Any other app or TV: finish typing in its field and confirm.
      this.typeDiff(session, textForTv(action.text, asciiOnly));
      if (this.state.canSubmit) session.submit();
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
    const gapMs = this.timing.searchScreen.retypeGapMs;
    const typeText = (last: boolean) => {
      if (this.session?.ready) this.session.updateText('', text);
      if (last) this.cancelAfterOpen();
    };
    delaysMs.forEach((delayMs, i) => {
      const last = i === delaysMs.length - 1;
      this.afterOpenTimers.push(
        setTimeout(() => {
          if (i === 0) return typeText(last);
          // Clear what an earlier try left, give the app time to process it, then type again.
          if (this.session?.ready) this.session.updateText(text, '');
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

  private typeDiff(session: TvSession, target: string) {
    if (target === this.tvText) return;
    session.updateText(this.tvText, target);
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
    const tv = this.state.tv;
    const driver = this.driver;
    if (!tv || !driver || this.pairingFlow || this.pairingBusy || !this.active) return;
    if (!driver.startPairing) {
      // Nothing to pair with a code: the TV refused us. Try again later.
      this.update({ pairing: { phase: 'failed', error: 'La tele no dio permiso a este celular.', prompt: null } });
      return;
    }
    this.pairingBusy = true;
    this.update({ connection: 'connecting', pairing: { phase: 'requesting', error: null, prompt: null } });
    try {
      const flow = await driver.startPairing(tv, this.ctx);
      if (!this.active) {
        flow.cancel();
        return;
      }
      this.pairingFlow = flow;
      flow.onClose(() => {
        if (this.pairingFlow !== flow) return;
        this.pairingFlow = null;
        this.update({ pairing: { phase: 'failed', error: 'Se cerró el código en la tele.', prompt: flow.prompt } });
      });
      if (this.pairingFlow !== flow) return;
      if (flow.prompt.kind === 'accept' && flow.accepted) {
        this.update({ pairing: { phase: 'waiting_accept', error: null, prompt: flow.prompt } });
        flow.accepted.then(
          (saved) => {
            if (this.pairingFlow !== flow) return;
            this.pairingFlow = null;
            this.saveCredentials(saved);
            this.update({ pairing: null, connection: 'connecting' });
            this.connect();
          },
          () => {
            if (this.pairingFlow !== flow) return;
            this.pairingFlow = null;
            this.update({ pairing: { phase: 'failed', error: 'La tele no dio permiso. Probá de nuevo.', prompt: flow.prompt } });
          },
        );
      } else {
        this.update({ pairing: { phase: 'waiting_code', error: null, prompt: flow.prompt } });
      }
    } catch {
      this.update({ pairing: { phase: 'failed', error: 'No pude pedirle el código a la tele. ¿Está prendida?', prompt: null } });
    } finally {
      this.pairingBusy = false;
    }
  }

  private cancelPairing() {
    this.pairingFlow?.cancel();
    this.pairingFlow = null;
  }

  /** The TV stopped answering: if it's on the Wi-Fi at another address (same TV), follow it. */
  private async rediscover() {
    const current = this.state.tv;
    if (!current) return;
    const found = await this.scanTvs();
    const tv = this.state.tv;
    if (!tv || tv !== current || !found.length || found.some((t) => t.host === tv.host && t.brand === tv.brand)) return;
    const same =
      found.find((t) => t.brand === tv.brand && !!tv.id && t.id === tv.id) ??
      found.find((t) => t.brand === tv.brand && !isIp(tv.name) && t.name === tv.name) ??
      (found.filter((t) => t.brand === tv.brand).length === 1 ? found.find((t) => t.brand === tv.brand) : undefined);
    if (!same) return;
    // Keep what the old record knew (e.g. its id), with the new address.
    const credentials = this.loadCredentials();
    this.saveTv({ ...tv, ...same, id: same.id ?? tv.id, hints: { ...tv.hints, ...same.hints } });
    if (credentials) this.saveCredentials(credentials);
    this.failures = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connect();
  }

  private closeSession() {
    const session = this.session;
    this.session = null;
    this.canSend = false;
    this.attempt++;
    this.opening = false;
    session?.close();
  }

  private clearTimers() {
    for (const timer of [this.warmTimer, this.retryTimer, this.idleTimer]) if (timer) clearTimeout(timer);
    this.warmTimer = this.retryTimer = this.idleTimer = null;
    this.cancelAfterOpen();
  }
}

/** New results first, keeping earlier finds that this search hasn't reported (yet). */
function mergeTvs(previous: TvInfo[], fresh: TvInfo[]): TvInfo[] {
  const byHost = new Map(previous.map((tv) => [tv.host, tv]));
  for (const tv of fresh) byHost.set(tv.host, tv);
  return [...byHost.values()].sort((a, b) => a.name.localeCompare(b.name));
}
