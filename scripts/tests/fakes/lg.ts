// A simulated LG webOS TV (SSAP over WebSocket) following aiowebostv / ConnectSDK.

import type { AddressInfo } from 'node:net';
import https from 'node:https';
import { WebSocketServer, type WebSocket } from 'ws';

import { selfSignedCert } from '../net';

export async function fakeLg(options: { knownKey?: string; name?: string } = {}) {
  const state = { field: '', entered: 0, focus: false, registeredKey: options.knownKey ?? null as string | null, pointerFrames: [] as string[] };
  const server = https.createServer(selfSignedCert());
  const wss = new WebSocketServer({ server, handleProtocols: () => false });
  let pointerPath = '';

  const main = new WebSocketServer({ noServer: true });
  const pointer = new WebSocketServer({ noServer: true });
  wss.close(); // use manual upgrade routing instead

  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').includes('netinput.pointer.sock')) {
      pointer.handleUpgrade(req, socket, head, (ws) => pointer.emit('connection', ws));
    } else {
      main.handleUpgrade(req, socket, head, (ws) => main.emit('connection', ws));
    }
  });

  pointer.on('connection', (ws) => {
    ws.on('message', (raw) => {
      for (const frame of raw.toString().split('\n\n')) if (frame.trim()) state.pointerFrames.push(frame.trim().replace(/\n/g, ' '));
    });
  });

  const sendFocus = (clients: Set<WebSocket>, focus: boolean) => {
    for (const c of clients) c.send(JSON.stringify({ type: 'response', id: lastKbdSub, payload: { subscribed: true, currentWidget: { focus } } }));
  };
  const clients = new Set<WebSocket>();
  let lastKbdSub = 'kbd';

  main.on('connection', (ws) => {
    clients.add(ws);
    ws.on('message', (raw) => {
      let msg: { id?: string; type?: string; uri?: string; payload?: Record<string, unknown> };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const id = msg.id ?? '';
      if (msg.type === 'hello') {
        ws.send(JSON.stringify({ type: 'hello', payload: { deviceUUID: 'lg-uuid-1', deviceOS: 'webOS' } }));
        return;
      }
      if (msg.type === 'register') {
        const sent = msg.payload?.['client-key'];
        if (sent && sent === state.registeredKey) {
          ws.send(JSON.stringify({ type: 'registered', id, payload: { 'client-key': state.registeredKey } }));
        } else {
          // Show the prompt, then "accept" after a beat and hand back a key.
          ws.send(JSON.stringify({ type: 'response', id, payload: { pairingType: 'PROMPT', returnValue: true } }));
          setTimeout(() => {
            state.registeredKey = 'KEY-' + Math.random().toString(16).slice(2, 10);
            ws.send(JSON.stringify({ type: 'registered', id, payload: { 'client-key': state.registeredKey } }));
          }, 30);
        }
        return;
      }
      if (msg.type === 'subscribe' && msg.uri?.includes('registerRemoteKeyboard')) {
        lastKbdSub = id;
        ws.send(JSON.stringify({ type: 'response', id, payload: { subscribed: true, currentWidget: { focus: state.focus } } }));
        return;
      }
      if (msg.type === 'request') {
        const uri = msg.uri ?? '';
        const ok = (payload: Record<string, unknown> = {}) => ws.send(JSON.stringify({ type: 'response', id, payload: { returnValue: true, ...payload } }));
        if (uri.endsWith('getSystemInfo')) return ok({ modelName: 'OLED55C1' });
        if (uri.endsWith('getPointerInputSocket')) return ok({ socketPath: pointerPath });
        if (uri.endsWith('ime/insertText')) {
          if (state.focus) state.field += String(msg.payload?.text ?? '');
          return ok();
        }
        if (uri.endsWith('ime/deleteCharacters')) {
          const n = Number(msg.payload?.count ?? 0);
          if (state.focus) state.field = Array.from(state.field).slice(0, -n).join('');
          return ok();
        }
        if (uri.endsWith('ime/sendEnterKey')) {
          state.entered++;
          return ok();
        }
        return ok();
      }
    });
    ws.on('close', () => clients.delete(ws));
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  pointerPath = `wss://127.0.0.1:${port}/resources/abc/netinput.pointer.sock`;
  return {
    port,
    state,
    openKeyboard() {
      state.focus = true;
      sendFocus(clients, true);
    },
    closeKeyboard() {
      state.focus = false;
      sendFocus(clients, false);
    },
    close: () => {
      main.close();
      pointer.close();
      server.close();
    },
  };
}
