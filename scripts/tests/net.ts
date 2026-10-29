// HTTP, WebSocket and MQTT clients (src/net) against independent servers:
// node:http/https, the `ws` package and the `aedes` MQTT broker.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { Aedes } from 'aedes';
import { WebSocketServer } from 'ws';

import { md5, sha1, hmacSha1, hmacSha256 } from '../../src/net/hash';
import { httpRequest } from '../../src/net/http';
import { MqttClient } from '../../src/net/mqtt';
import { WebSocketClient } from '../../src/net/websocket';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { bytesToHex } from '../../src/protocol/bytes';
import { nodeTransport } from '../nodeTransport';

export function selfSignedCert(): { key: string; cert: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-days', '2', '-subj', '/CN=tv.local'], { stdio: 'ignore' });
  return { key: fs.readFileSync(`${dir}/k.pem`, 'utf8'), cert: fs.readFileSync(`${dir}/c.pem`, 'utf8') };
}

const port = (server: { address(): AddressInfo | string | null }) => (server.address() as AddressInfo).port;

export async function netTests(test: (name: string, fn: () => void | Promise<void>) => Promise<void>) {
  await test('sha1, md5 and hmac match node:crypto', () => {
    for (const len of [0, 1, 55, 56, 64, 65, 200]) {
      const data = new Uint8Array(randomBytes(len));
      assert.equal(bytesToHex(sha1(data)), createHash('sha1').update(data).digest('hex'));
      assert.equal(bytesToHex(md5(data)), createHash('md5').update(data).digest('hex'));
      const key = new Uint8Array(randomBytes(len % 3 === 0 ? 100 : 20));
      assert.equal(bytesToHex(hmacSha1(key, data)), createHmac('sha1', key).update(data).digest('hex'));
      assert.equal(bytesToHex(hmacSha256(key, data)), createHmac('sha256', key).update(data).digest('hex'));
    }
  });

  await test('http: content-length, chunked, close-delimited, https self-signed', async () => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/chunked') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.write('ho');
          res.write('la ');
          res.end('ñandú');
        } else if (req.url === '/close') {
          res.socket?.end('HTTP/1.1 200 OK\r\nX-A: 1\r\n\r\nhasta el cierre');
        } else {
          res.writeHead(201, { 'Set-Cookie': ['a=1', 'b=2'], 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ method: req.method, url: req.url, body, auth: req.headers['x-auth-psk'] ?? null }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${port(server)}`;
    const a = await httpRequest(nodeTransport, { url: `${base}/sony/system?x=1`, body: '{"id":1}', headers: { 'X-Auth-PSK': '0000' } });
    assert.equal(a.status, 201);
    assert.deepEqual(a.json(), { method: 'POST', url: '/sony/system?x=1', body: '{"id":1}', auth: '0000' });
    assert.equal(a.headers['set-cookie'], 'a=1\nb=2');
    assert.equal((await httpRequest(nodeTransport, { url: `${base}/chunked` })).text(), 'hola ñandú');
    assert.equal((await httpRequest(nodeTransport, { url: `${base}/close` })).text(), 'hasta el cierre');
    server.close();

    const tlsServer = https.createServer(selfSignedCert(), (_req, res) => res.end('seguro'));
    await new Promise<void>((r) => tlsServer.listen(0, '127.0.0.1', r));
    assert.equal((await httpRequest(nodeTransport, { url: `https://127.0.0.1:${port(tlsServer)}/` })).text(), 'seguro');
    tlsServer.close();
  });

  await test('http: times out when the server never answers', async () => {
    const server = net.createServer(() => {});
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    await assert.rejects(httpRequest(nodeTransport, { url: `http://127.0.0.1:${port(server)}/`, timeoutMs: 600 }), /timeout/);
    server.close();
  });

  await test('websocket: ws and wss (self-signed) against the ws package', async () => {
    for (const secure of [false, true]) {
      const httpServer = secure ? https.createServer(selfSignedCert()) : http.createServer();
      const wss = new WebSocketServer({ server: httpServer });
      const received: string[] = [];
      let path = '';
      wss.on('connection', (socket, req) => {
        path = req.url ?? '';
        socket.send('hola desde la tele');
        socket.on('message', (data, isBinary) => {
          const text = isBinary ? `bin:${(data as Buffer).length}` : data.toString();
          received.push(text);
          if (text === 'grande') socket.send('x'.repeat(70_000));
          if (text === 'chau') socket.close(1000);
        });
      });
      await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
      const url = `${secure ? 'wss' : 'ws'}://127.0.0.1:${port(httpServer)}/api/v2/channels/samsung.remote.control?name=VGVjbGFkbw==`;
      const ws = await WebSocketClient.connect(nodeTransport, url);
      const messages: (string | Uint8Array)[] = [];
      let closed: string | null | undefined;
      ws.setHandlers(
        (m) => messages.push(m),
        (e) => (closed = e),
      );
      ws.send('ñandú 😀');
      ws.send('y'.repeat(300));
      ws.send(new Uint8Array(70_000));
      ws.send('grande');
      await new Promise((r) => setTimeout(r, 200));
      ws.send('chau');
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(path, '/api/v2/channels/samsung.remote.control?name=VGVjbGFkbw==');
      assert.deepEqual(received, ['ñandú 😀', 'y'.repeat(300), 'bin:70000', 'grande', 'chau']);
      assert.equal(messages[0], 'hola desde la tele');
      assert.equal((messages[1] as string).length, 70_000);
      assert.equal(closed, null);
      wss.close();
      httpServer.close();
    }
  });

  await test('websocket: refused upgrade reports the HTTP status', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(403);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    await assert.rejects(WebSocketClient.connect(nodeTransport, `ws://127.0.0.1:${port(server)}/`), (e: Error & { status?: number }) => e.status === 403);
    server.close();
  });

  await test('mqtt: connect with user/password, subscribe, publish both ways (aedes broker)', async () => {
    const broker = await Aedes.createBroker();
    broker.authenticate = (_client, username, password, done) => done(null, username === 'hisenseservice' && password?.toString() === 'multimqttservice');
    const server = net.createServer(broker.handle);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const fromPhone: string[] = [];
    broker.subscribe('/remoteapp/tv/#', (packet, cb) => {
      fromPhone.push(`${packet.topic}=${packet.payload.toString()}`);
      cb();
    }, () => {});
    await assert.rejects(
      MqttClient.connect(nodeTransport, { host: '127.0.0.1', port: port(server), mode: 'tcp', clientId: 'x', username: 'mal', password: 'mal' }),
      (e: Error & { returnCode?: number }) => e.returnCode === 4 || e.returnCode === 5,
    );
    const client = await MqttClient.connect(nodeTransport, {
      host: '127.0.0.1',
      port: port(server),
      mode: 'tcp',
      clientId: 'tecladotv',
      username: 'hisenseservice',
      password: 'multimqttservice',
    });
    const got: string[] = [];
    client.setHandlers((topic, payload) => got.push(`${topic}=${Buffer.from(payload).toString()}`), () => {});
    await client.subscribe(['/remoteapp/mobile/tecladotv/#']);
    client.publish('/remoteapp/tv/remote_service/tecladotv/actions/sendkey', 'KEY_OK');
    broker.publish({ topic: '/remoteapp/mobile/tecladotv/ui_service/data/hotelmodechange', payload: Buffer.from('{"a":1}'), qos: 0, retain: false, cmd: 'publish', dup: false }, () => {});
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(fromPhone, ['/remoteapp/tv/remote_service/tecladotv/actions/sendkey=KEY_OK']);
    assert.deepEqual(got, ['/remoteapp/mobile/tecladotv/ui_service/data/hotelmodechange={"a":1}']);
    client.close();
    server.close();
    broker.close();
  });
}
