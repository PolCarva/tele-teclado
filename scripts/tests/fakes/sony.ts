// A simulated Sony BRAVIA (Scalar Web API) following Sony's REST docs and pybravia.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export async function fakeSony(options: { pin?: string; name?: string } = {}) {
  const state = { field: '', keyboardOn: false, ircc: [] as string[], cookie: null as string | null, pinsShown: 0 };
  const pin = options.pin ?? '1234';
  const authOk = (req: http.IncomingMessage) => !!state.cookie && (req.headers.cookie ?? '').includes(`auth=${state.cookie}`);
  const rpc = (res: http.ServerResponse, result: unknown[], id = 2) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result, id }));
  };
  const rpcError = (res: http.ServerResponse, code: number, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: [code, 'err'], id: 2 }));
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'GET' && url === '/dmr.xml') {
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(
          `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:av="urn:schemas-sony-com:av"><device><friendlyName>BRAVIA ${options.name ?? 'KDL-42W805A'}</friendlyName><manufacturer>Sony Corporation</manufacturer><modelName>KDL-42W805A</modelName><UDN>uuid:sony-123</UDN><av:X_ScalarWebAPI_DeviceInfo><av:X_ScalarWebAPI_ServiceList><av:X_ScalarWebAPI_ServiceType>videoScreen</av:X_ScalarWebAPI_ServiceType></av:X_ScalarWebAPI_ServiceList></av:X_ScalarWebAPI_DeviceInfo></device></root>`,
        );
        return;
      }
      let json: { method?: string; params?: unknown[] } = {};
      try {
        json = JSON.parse(body);
      } catch {
        // not json
      }
      if (url === '/sony/system' && json.method === 'getInterfaceInformation') return rpc(res, [{ modelName: 'KDL-42W805A' }]);
      if (url === '/sony/accessControl' && json.method === 'actRegister') {
        const auth = req.headers.authorization ?? '';
        if (!auth) {
          state.pinsShown++;
          return rpcError(res, 401, 401); // PIN shown on TV
        }
        const got = Buffer.from(auth.replace(/^Basic\s+/, ''), 'base64').toString('utf8').replace(/^:/, '');
        if (got !== pin) return rpcError(res, 401, 401);
        state.cookie = 'tok-' + Math.random().toString(16).slice(2, 10);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `auth=${state.cookie}; path=/sony/; max-age=1209600` });
        res.end(JSON.stringify({ result: [], id: 1 }));
        return;
      }
      if (url === '/sony/appControl') {
        if (!authOk(req)) return rpcError(res, 403, 403);
        if (json.method === 'getApplicationStatusList') return rpc(res, [[{ name: 'textInput', status: state.keyboardOn ? 'on' : 'off' }]]);
        if (json.method === 'setTextForm') {
          if (!state.keyboardOn) return rpcError(res, 7);
          state.field = String((json.params ?? [''])[0]);
          return rpc(res, [0]);
        }
      }
      if (url === '/sony/ircc') {
        const code = /<IRCCCode>([^<]*)<\/IRCCCode>/.exec(body)?.[1] ?? '';
        state.ircc.push(code);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end('<ok/>');
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    state,
    openKeyboard: () => (state.keyboardOn = true),
    close: () => server.close(),
  };
}
