// A simulated Samsung Tizen TV: the REST device-info endpoint and the samsung.remote.control
// WebSocket, following xchwarze/samsung-tv-ws-api and couch-remote.

import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

import { selfSignedCert } from '../net';

export async function fakeSamsung(options: { token?: boolean; requirePrompt?: boolean; name?: string } = {}) {
  const token = options.token ?? true;
  const state = { field: '', keyboardOpen: false, inputEnds: 0, keys: [] as string[], paired: !options.requirePrompt, lastText: '' };
  const clients = new Set<WebSocket>();

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
    const url = new URL(req.url ?? '/', 'http://x');
    // Token TVs: if the client sent no token and we require a prompt, grant one after a beat.
    const sentToken = url.searchParams.get('token');
    const grant = () => {
      if (token && !sentToken && !state.paired) state.paired = true;
      ws.send(JSON.stringify({ event: 'ms.channel.connect', data: { id: 'client-1', token: token ? '85418879' : undefined } }));
    };
    setTimeout(grant, 20);
    ws.on('message', (raw) => {
      let msg: { method?: string; params?: Record<string, unknown> };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.method !== 'ms.remote.control') return;
      const p = msg.params ?? {};
      if (p.TypeOfRemote === 'SendInputString' && state.keyboardOpen) {
        state.field = Buffer.from(String(p.Cmd ?? ''), 'base64').toString('utf8'); // replace
        state.lastText = state.field;
      } else if (p.TypeOfRemote === 'SendInputEnd') {
        state.inputEnds++;
        state.keyboardOpen = false;
        for (const c of clients) c.send(JSON.stringify({ event: 'ms.remote.imeEnd' }));
      } else if (p.TypeOfRemote === 'SendRemoteKey' && p.Cmd === 'Click') {
        state.keys.push(String(p.DataOfCmd));
      }
    });
    ws.on('close', () => clients.delete(ws));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    state,
    /** Simulates a text field gaining focus on the TV (its keyboard opens). */
    openKeyboard(text = '') {
      state.keyboardOpen = true;
      state.field = text;
      for (const c of clients) {
        c.send(JSON.stringify({ event: 'ms.remote.imeStart', data: 'input' }));
        if (text) c.send(JSON.stringify({ event: 'ms.remote.imeUpdate', data: Buffer.from(text, 'utf8').toString('base64') }));
      }
    },
    close: () => {
      wss.close();
      server.close();
    },
  };
}
