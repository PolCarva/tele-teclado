// A simulated Panasonic VIERA that follows the NRC protocol as panasonic-viera / vieramatic
// describe it, with the TV side of the 2019+ encryption written with node:crypto.

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const NRC = 'urn:panasonic-com:service:p00NetworkControl:1';
const MASK = Buffer.from('15C95AC2B08AA7EB4E228F811E34D04FA54BA7DCAC9879FA8ACDA3FC244F3854', 'hex');

type Keys = { iv: Buffer; key: Buffer; hmac: Buffer };

function pairKeys(c: Buffer): Keys {
  const key = Buffer.alloc(16);
  for (let i = 0; i < 16; i += 4) {
    key[i] = ~c[i + 3] & 0xff;
    key[i + 1] = ~c[i + 2] & 0xff;
    key[i + 2] = ~c[i + 1] & 0xff;
    key[i + 3] = ~c[i] & 0xff;
  }
  const hmac = Buffer.alloc(32);
  for (let i = 0; i < 32; i += 4) {
    hmac[i] = MASK[i] ^ c[(i + 2) & 15];
    hmac[i + 1] = MASK[i + 1] ^ c[(i + 3) & 15];
    hmac[i + 2] = MASK[i + 2] ^ c[i & 15];
    hmac[i + 3] = MASK[i + 3] ^ c[(i + 1) & 15];
  }
  return { iv: c, key, hmac };
}

function sessKeys(k: Buffer): Keys {
  const key = Buffer.alloc(16);
  for (let i = 0; i < 16; i += 4) {
    key[i] = k[i + 2];
    key[i + 1] = k[i + 3];
    key[i + 2] = k[i];
    key[i + 3] = k[i + 1];
  }
  return { iv: k, key, hmac: Buffer.concat([k, k]) };
}

function tvSeal(k: Keys, text: string): string {
  const d = Buffer.from(text, 'utf8');
  const head = Buffer.alloc(16);
  randomBytes(12).copy(head);
  head.writeUInt32BE(d.length, 12);
  let plain = Buffer.concat([head, d]);
  plain = Buffer.concat([plain, Buffer.alloc(16 - (plain.length % 16))]);
  const c = createCipheriv('aes-128-cbc', k.key, k.iv).setAutoPadding(false);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([ct, createHmac('sha256', k.hmac).update(ct).digest()]).toString('base64');
}

function tvOpen(k: Keys, b64: string): string {
  const raw = Buffer.from(b64, 'base64');
  const ct = raw.subarray(0, raw.length - 32);
  const mac = raw.subarray(raw.length - 32);
  if (!createHmac('sha256', k.hmac).update(ct).digest().equals(mac)) throw new Error('bad hmac');
  const d = createDecipheriv('aes-128-cbc', k.key, k.iv).setAutoPadding(false);
  const plain = Buffer.concat([d.update(ct), d.final()]);
  const len = plain.readUInt32BE(12);
  return plain.subarray(16, 16 + len).toString('utf8');
}

const tag = (xml: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1];
const unescape = (t: string) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export async function fakePanasonic(options: { encrypted: boolean; pin?: string }) {
  const state = {
    field: '',
    keys: [] as string[],
    pin: options.pin ?? '1234',
    challenge: null as Buffer | null,
    appId: 'BSkeeKuuwakd9Q==',
    encKey: randomBytes(16),
    sessionId: 0,
    lastSeq: 0,
    pinsShown: 0,
    errors: [] as string[],
  };
  const fault = (res: http.ServerResponse, code: number, description: string) => {
    res.writeHead(500, { 'Content-Type': 'text/xml' });
    res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${description}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`);
  };
  const reply = (res: http.ServerResponse, action: string, inner = '') => {
    res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"', Connection: 'close' });
    res.end(`<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action}Response xmlns:u="${NRC}">${inner}</u:${action}Response></s:Body></s:Envelope>`);
  };
  const runCommand = (action: string, body: string) => {
    if (action === 'X_SendString') state.field += unescape(tag(body, 'X_String') ?? '');
    else if (action === 'X_SendKey') state.keys.push(tag(body, 'X_KeyEvent') ?? '?');
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/nrc/ddd.xml') {
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(`<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>urn:panasonic-com:device:p00RemoteController:1</deviceType><friendlyName>49DX600_Series</friendlyName><manufacturer>Panasonic</manufacturer><modelName>Panasonic VIErA</modelName><modelNumber>TX-49DX600EA</modelNumber><UDN>uuid:4D454930-0200-1000-8001-A81374B30314</UDN></device></root>`);
        return;
      }
      if (req.method === 'GET' && req.url === '/nrc/sdd_0.xml') {
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        const actions = ['X_SendKey', 'X_SendString', 'X_GetInputMode', ...(options.encrypted ? ['X_DisplayPinCode', 'X_RequestAuth', 'X_GetEncryptSessionId', 'X_EncryptedCommand'] : [])];
        res.end(`<scpd><actionList>${actions.map((a) => `<action><name>${a}</name></action>`).join('')}</actionList></scpd>`);
        return;
      }
      if (req.method !== 'POST' || req.url !== '/nrc/control_0') {
        res.writeHead(404);
        res.end();
        return;
      }
      const action = /#(\w+)"?$/.exec(String(req.headers.soapaction ?? ''))?.[1] ?? '';
      if (!body.includes(`<u:${action} xmlns:u="${NRC}">`)) return fault(res, 401, 'Invalid action');
      try {
        if (!options.encrypted) {
          runCommand(action, body);
          return reply(res, action);
        }
        switch (action) {
          case 'X_DisplayPinCode':
            state.challenge = randomBytes(16);
            state.pinsShown++;
            return reply(res, action, `<X_ChallengeKey>${state.challenge.toString('base64')}</X_ChallengeKey>`);
          case 'X_RequestAuth': {
            if (!state.challenge) return fault(res, 600, 'Invalid PIN code');
            const keys = pairKeys(state.challenge);
            const inner = tvOpen(keys, tag(body, 'X_AuthInfo')!);
            if (tag(inner, 'X_PinCode') !== state.pin) return fault(res, 600, 'Invalid PIN code');
            return reply(res, action, `<X_AuthResult>${tvSeal(keys, `<X_ApplicationId>${state.appId}</X_ApplicationId>\r\n<X_Keyword>${state.encKey.toString('base64')}</X_Keyword>`)}</X_AuthResult>`);
          }
          case 'X_GetEncryptSessionId': {
            const keys = sessKeys(state.encKey);
            if (tag(body, 'X_ApplicationId') !== state.appId) return fault(res, 401, 'unknown app');
            const inner = tvOpen(keys, tag(body, 'X_EncInfo')!);
            if (tag(inner, 'X_ApplicationId') !== state.appId) return fault(res, 401, 'bad app id');
            state.sessionId = 1000 + Math.floor(Math.random() * 1000);
            state.lastSeq = 0;
            return reply(res, action, `<X_ApplicationId>${state.appId}</X_ApplicationId><X_EncResult>${tvSeal(keys, `<X_ApplicationId>${state.appId}</X_ApplicationId><X_SessionId>${state.sessionId}</X_SessionId>`)}</X_EncResult>`);
          }
          case 'X_EncryptedCommand': {
            const keys = sessKeys(state.encKey);
            const inner = tvOpen(keys, tag(body, 'X_EncInfo')!);
            if (Number(tag(inner, 'X_SessionId')) !== state.sessionId) return fault(res, 612, 'No such session');
            const seq = Number(tag(inner, 'X_SequenceNumber'));
            if (!(seq > state.lastSeq) || tag(inner, 'X_SequenceNumber')!.length !== 8) return fault(res, 401, 'bad seq');
            state.lastSeq = seq;
            const original = tag(inner, 'X_OriginalCommand')!;
            const inAction = /<u:(\w+) xmlns:u="urn:panasonic-com:service:p00NetworkControl:1">/.exec(original)?.[1] ?? '';
            runCommand(inAction, original);
            return reply(res, action, `<X_EncResult>${tvSeal(keys, `<u:${inAction}Response xmlns:u="${NRC}"></u:${inAction}Response>`)}</X_EncResult>`);
          }
          default:
            // Encrypted TVs refuse plain commands.
            return fault(res, 401, 'Invalid action');
        }
      } catch (e) {
        state.errors.push(String(e));
        return fault(res, 500, String(e));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    state,
    /** Simulates the TV losing power: the session is gone. */
    dropSession: () => (state.sessionId = -1),
    close: () => server.close(),
  };
}
