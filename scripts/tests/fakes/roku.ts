// A simulated Roku ECP server following the official External Control Protocol docs.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export async function fakeRoku(options: { mode?: 'enabled' | 'limited' | 'disabled'; name?: string } = {}) {
  let mode = options.mode ?? 'enabled';
  const state = { field: '', keys: [] as string[] };
  const blocked = (res: http.ServerResponse) => {
    if (mode === 'disabled') {
      res.writeHead(401);
      res.end();
      return true;
    }
    if (mode === 'limited') {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset="utf-8"' });
      res.end('ECP command not allowed in Limited mode.');
      return true;
    }
    return false;
  };
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url.startsWith('/query/device-info')) {
      // device-info answers even in limited/disabled (disabled → 401 everywhere else).
      if (mode === 'disabled') {
        res.writeHead(401, { Server: 'Roku/16.0.0' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/xml', Server: 'Roku/15.3.0' });
      res.end(`<device-info><udn>abc-udn</udn><serial-number>YH001</serial-number><vendor-name>TCL</vendor-name><model-name>55R635</model-name><user-device-name>${options.name ?? 'Tele del living'}</user-device-name><is-tv>true</is-tv><ecp-setting-mode>${mode}</ecp-setting-mode><supports-ecs-textedit>true</supports-ecs-textedit></device-info>`);
      return;
    }
    if (req.method === 'GET' && url.startsWith('/query/apps')) {
      if (blocked(res)) return;
      res.writeHead(200, { 'Content-Type': 'text/xml', Server: 'Roku/15.3.0' });
      res.end('<apps><app id="12">Netflix</app></apps>');
      return;
    }
    if (req.method === 'POST' && url.startsWith('/keypress/')) {
      if (blocked(res)) return;
      const key = decodeURIComponent(url.slice('/keypress/'.length));
      if (key.startsWith('Lit_')) state.field += decodeURIComponent(key.slice(4));
      else if (key === 'Backspace') state.field = Array.from(state.field).slice(0, -1).join('');
      else state.keys.push(key);
      res.writeHead(200);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    state,
    /** The user changes "Control by mobile apps" on the TV. */
    setMode: (next: typeof mode) => {
      mode = next;
    },
    close: () => server.close(),
  };
}
