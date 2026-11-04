// A simulated Fire TV built from the community protocol docs: zane-programs fire-tv/PROTOCOL.md
// (endpoints, headers, pairing), LibreControl/fire-tv docs/protocol.md and its test fixture
// tests/helpers/native-server.ts, and the hardware observations in LibreControl's
// docs/hardware-validation.md (Fire TV Stick 4K Plus, 2026-10-19). It is not captured traffic.
//
// - DIAL (plain HTTP): POST /apps/FireTVRemote starts the remote service (201 + Location); until
//   then the HTTPS port refuses connections (Home Assistant thread 901314, post 3).
// - Remote API (HTTPS, self-signed): every request needs `x-api-key: 0987654321` and
//   `Content-Type: application/json; charset=utf-8` (400 otherwise, as the LibreControl fixture; HA
//   posts 3 and 9: "Bad arguments supplied" until the Content-Type was added). Without a valid
//   `x-client-token`: 403, as the real stick answered.
// - Keyboard: `hidden`/null with no field, `visible`/`keyboard` when one opens, `text`/`keyboard`
//   after typing (hardware). POST /v1/FireTV/keyboard adds the text at the end of the field: that's
//   the LibreControl fixture's model, not proven on hardware. With no field open the text is dropped
//   but the answer is still 200 (the stick answered 200 to a text route that typed nothing).

import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';

import { selfSignedCert } from '../net';

export const FAKE_FIRETV_UUID = '8338a484-3a63-3e89-8d0d-8642ee85f305';

/** Device description shape from LibreControl tests/helpers/dial-server.ts ("Captured device shape"). */
function description(name: string, manufacturer: string, model: string, uuid: string) {
  return `<root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:r="urn:restful-tv-org:schemas:upnp-dd"><specVersion><major>1</major><minor>0</minor></specVersion><device><deviceType>urn:schemas-upnp-org:device:tvdevice:1</deviceType><friendlyName>${name}</friendlyName><manufacturer>${manufacturer}</manufacturer><modelName>${model}</modelName><UDN>uuid:${uuid}</UDN></device></root>`;
}

export async function fakeFireTv(options: { pin?: string; name?: string; asleep?: boolean } = {}) {
  const pin = options.pin ?? '4826';
  const state = {
    awake: !options.asleep,
    wakes: 0,
    pinsShown: 0,
    friendlyName: '',
    token: null as string | null,
    keyboard: 'hidden' as 'hidden' | 'visible' | 'text',
    field: '',
    /** Bodies of every POST /v1/FireTV/keyboard, in order. */
    textPosts: [] as string[],
    /** Text that arrived with no field open (answered 200, typed nothing). */
    dropped: [] as string[],
    /** Requests to the old per-character route /v1/FireTV/text. */
    obsolete: 0,
    /** "dpad_up:keyDown", "home"… */
    keys: [] as string[],
    badRequests: [] as string[],
  };

  const reply = (res: http.ServerResponse, status: number, value?: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(value === undefined ? '' : JSON.stringify(value));
  };
  const bad = (res: http.ServerResponse, why: string) => {
    state.badRequests.push(why);
    reply(res, 400, { description: 'Bad arguments supplied. Please check inputs.' });
  };

  const remote = https.createServer(selfSignedCert(), (req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'https://fire.tv');
      if (req.headers['x-api-key'] !== '0987654321') return bad(res, `api key on ${url.pathname}`);
      if (req.headers['content-type'] !== 'application/json; charset=utf-8') return bad(res, `content-type on ${url.pathname}`);
      let body: Record<string, unknown> = {};
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          return bad(res, `json on ${url.pathname}`);
        }
      }
      if (req.method === 'POST' && url.pathname === '/v1/FireTV/pin/display') {
        if (typeof body.friendlyName !== 'string' || !body.friendlyName) return bad(res, 'friendlyName');
        state.pinsShown++;
        state.friendlyName = body.friendlyName;
        return reply(res, 200, { description: 'OK' });
      }
      if (req.method === 'POST' && url.pathname === '/v1/FireTV/pin/verify') {
        if (!state.pinsShown || typeof body.pin !== 'string') return bad(res, 'pin');
        if (body.pin !== pin) return reply(res, 200, { description: '' });
        state.token = 'NtuqAPiEeILpVJdLr9f2lA';
        return reply(res, 200, { description: state.token });
      }
      if (!state.token || req.headers['x-client-token'] !== state.token) return reply(res, 403);
      if (req.method === 'GET' && url.pathname === '/v1/FireTV/status') {
        return reply(res, 200, { osVersion: '0032548774788', platformType: 'android', turnstileVersion: '0.1.147068' });
      }
      if (req.method === 'GET' && url.pathname === '/v1/FireTV/keyboard') {
        const open = state.keyboard !== 'hidden';
        return reply(res, 200, { state: state.keyboard, mode: open ? 'keyboard' : null, text: open ? state.field : null });
      }
      if (req.method === 'POST' && url.pathname === '/v1/FireTV/keyboard') {
        if (typeof body.text !== 'string') return bad(res, 'text');
        state.textPosts.push(body.text);
        if (state.keyboard === 'hidden') state.dropped.push(body.text);
        else {
          state.field += body.text;
          state.keyboard = 'text';
        }
        return reply(res, 200, { description: 'OK' });
      }
      if (req.method === 'POST' && url.pathname === '/v1/FireTV/text') {
        state.obsolete++;
        return reply(res, 200, { description: 'OK' });
      }
      if (req.method === 'POST' && url.pathname === '/v1/FireTV') {
        const action = url.searchParams.get('action') ?? '';
        if (/^(dpad_(up|down|left|right)|select)$/.test(action)) {
          if (body.keyActionType !== 'keyDown' && body.keyActionType !== 'keyUp') return bad(res, 'keyActionType');
          state.keys.push(`${action}:${body.keyActionType}`);
          return reply(res, 200, { description: 'OK' });
        }
        if (/^(home|back|menu)$/.test(action) && raw === '') {
          state.keys.push(action);
          return reply(res, 200, { description: 'OK' });
        }
        return bad(res, `action ${action}`);
      }
      reply(res, 404);
    });
  });

  // DIAL and the device description on plain HTTP. `/other.xml` stands for another DIAL device on
  // the network (a Chromecast), which must not be taken for a Fire TV.
  const dial = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/dd.xml') {
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        res.end(description(options.name ?? 'Fire TV Living', 'Amazon', 'AFTMA08C15', FAKE_FIRETV_UUID));
        return;
      }
      if (req.method === 'GET' && req.url === '/other.xml') {
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        res.end(description('Chromecast Living', 'Google Inc.', 'Chromecast', '11111111-2222-3333-4444-555555555555'));
        return;
      }
      if (req.method === 'POST' && req.url === '/apps/FireTVRemote') {
        if (raw !== '' || !/^text\/plain/.test(req.headers['content-type'] ?? '')) {
          state.badRequests.push('dial');
          res.writeHead(400);
          res.end();
          return;
        }
        state.wakes++;
        void listenRemote().then(() => {
          res.writeHead(201, { Location: `http://${req.headers.host}/apps/FireTVRemote/run` });
          res.end();
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  // The HTTPS port is fixed up front so the test's address map can point at it while the service sleeps.
  let remotePort = 0;
  const listenRemote = async () => {
    if (remote.listening) return;
    await new Promise<void>((r) => remote.listen(remotePort, '127.0.0.1', r));
    remotePort = (remote.address() as AddressInfo).port;
    state.awake = true;
  };
  const sleepRemote = async () => {
    state.awake = false;
    remote.closeAllConnections();
    await new Promise<void>((r) => remote.close(() => r()));
  };
  await listenRemote();
  if (options.asleep) await sleepRemote();
  await new Promise<void>((r) => dial.listen(0, '127.0.0.1', r));

  return {
    port: remotePort,
    dialPort: (dial.address() as AddressInfo).port,
    state,
    openKeyboard: () => (state.keyboard = state.field ? 'text' : 'visible'),
    closeKeyboard: () => {
      state.keyboard = 'hidden';
      state.field = '';
    },
    /** The user removed this phone on the TV (or reset it): the token stops working. */
    revoke: () => (state.token = null),
    /** The remote service went to sleep (it "needs to wake up each time it has sat", HA post 29). */
    sleepService: sleepRemote,
    close: () => {
      remote.closeAllConnections();
      if (remote.listening) remote.close();
      dial.close();
    },
  };
}
