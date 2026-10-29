// A simulated Samsung Tizen TV: the REST device-info endpoint and the samsung.remote.control
// WebSocket, following xchwarze/samsung-tv-ws-api and couch-remote.
// IME events follow real-TV logs: imeStart {data: kind, entrylimit}, imeDone, then imeUpdate with the
// field's text (base64; "" when empty, always "" in password fields), and another imeUpdate after
// every change (tavicu/homebridge-samsung-tizen#733, dobrou remote.html, freman gist).

import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

import { selfSignedCert } from '../net';

export async function fakeSamsung(options: { token?: boolean; requirePrompt?: boolean; holdPrompt?: boolean; name?: string; echoMs?: number } = {}) {
  const token = options.token ?? true;
  const echoMs = options.echoMs ?? 30;
  const state = { field: '', keyboardOpen: false, kind: 'input', inputEnds: 0, keys: [] as string[], paired: !options.requirePrompt, lastText: '', openSockets: 0, sent: [] as string[] };
  const clients = new Set<WebSocket>();
  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
  const broadcast = (msg: object) => {
    for (const c of clients) c.send(JSON.stringify(msg));
  };
  const reportField = (text = state.field) => broadcast({ data: state.kind === 'password' ? '' : b64(text), entrylimit: state.kind === 'password' ? 63 : 2048, event: 'ms.remote.imeUpdate' });

  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.url?.startsWith('/api/v2')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          device: { type: 'Samsung SmartTV', OS: 'Tizen', name: `[TV] ${options.name ?? 'Samsung Q65'}`, modelName: 'QE55Q65AAUXXC', id: 'uuid:aa-bb', TokenAuthSupport: token ? 'true' : 'false' },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  };
  const server = token ? https.createServer(selfSignedCert(), handler) : http.createServer(handler);
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    clients.add(ws);
    state.openSockets++;
    const url = new URL(req.url ?? '/', 'http://x');
    const sentToken = url.searchParams.get('token');
    const grant = () => {
      if (token && !sentToken && !state.paired) state.paired = true;
      ws.send(JSON.stringify({ event: 'ms.channel.connect', data: { id: 'client-1', token: token ? '85418879' : undefined } }));
    };
    if (!options.holdPrompt) setTimeout(grant, 20);
    ws.on('message', (raw) => {
      let msg: { method?: string; params?: Record<string, unknown> };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.method !== 'ms.remote.control') return;
      const p = msg.params ?? {};
      if (p.TypeOfRemote === 'SendInputString') {
        const text = Buffer.from(String(p.Cmd ?? ''), 'base64').toString('utf8');
        state.sent.push(text);
        if (!state.keyboardOpen) return; // no focused field: the TV ignores it (couch-remote, ISF focus_flag)
        state.field = text; // replace
        state.lastText = state.field;
        // The field reports its new text a moment later, like the TV does after every change.
        setTimeout(() => state.keyboardOpen && reportField(text), echoMs);
      } else if (p.TypeOfRemote === 'SendInputEnd') {
        state.inputEnds++;
        state.keyboardOpen = false;
        broadcast({ event: 'ms.remote.imeEnd' });
      } else if (p.TypeOfRemote === 'SendRemoteKey' && p.Cmd === 'Click') {
        state.keys.push(String(p.DataOfCmd));
      }
    });
    ws.on('close', () => {
      clients.delete(ws);
      state.openSockets--;
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    state,
    /** Simulates a text field gaining focus on the TV (its keyboard opens), in the order real TVs report it. */
    openKeyboard(text = '', kind = 'input') {
      state.keyboardOpen = true;
      state.kind = kind;
      state.field = text;
      broadcast({ data: kind, entrylimit: kind === 'password' ? -1 : 2048, event: 'ms.remote.imeStart' });
      broadcast({ data: 'enable', event: 'ms.remote.imeDone' });
      reportField();
    },
    /** The TV's keyboard was already open before we connected (no imeStart for this client). */
    /** Someone types on the TV itself (remote's on-screen keyboard): the field reports its new text. */
    tvTypes(text: string) {
      state.field = text;
      reportField();
    },
    keyboardAlreadyOpen(text = '') {
      state.keyboardOpen = true;
      state.field = text;
    },
    close: () => {
      wss.close();
      server.close();
    },
  };
}
