// Offline checks for the protocol pieces (no TV needed): npm run selftest

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import { base64Decode, base64Encode, bytesToHex, hexToBytes, utf8Decode, utf8Encode } from '../src/protocol/bytes';
import { parseRemote, remote } from '../src/protocol/messages';
import { pairingSecret } from '../src/protocol/pairing';
import { Deframer, frame, PbMessage, PbWriter } from '../src/protocol/pb';
import { sha256 } from '../src/protocol/sha256';
import { diffText, textForTv } from '../src/protocol/textSync';
import { BufferedConnection, type Transport } from '../src/protocol/transport';
import { autoTarget, SEARCH_APPS } from '../src/tv/apps';
import { TvController } from '../src/tv/TvController';
import { brandTests, brandTests2, brandTests3 } from './tests/brands';
import { netTests } from './tests/net';
import { resilienceTests } from './tests/resilience';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

test('sha256 matches node:crypto', () => {
  for (const len of [0, 1, 55, 56, 63, 64, 65, 300, 1000]) {
    const data = randomBytes(len);
    assert.equal(bytesToHex(sha256(new Uint8Array(data))), createHash('sha256').update(data).digest('hex'));
  }
});

test('base64 and utf8 round trip', () => {
  for (const len of [0, 1, 2, 3, 4, 100]) {
    const data = new Uint8Array(randomBytes(len));
    assert.equal(base64Encode(data), Buffer.from(data).toString('base64'));
    assert.deepEqual(base64Decode(base64Encode(data)), data);
  }
  const text = 'hola ñandú camión ¿qué? 😀';
  assert.deepEqual(utf8Encode(text), new Uint8Array(Buffer.from(text, 'utf8')));
  assert.equal(utf8Decode(utf8Encode(text)), text);
});

test('ime text message matches androidtvremote2', () => {
  // Bytes produced by the Python reference for send_text("hola") with counters 0.
  const ours = bytesToHex(remote.imeText('hola', 0, 0));
  assert.equal(ours, 'aa01101a0e0801120a080310031a04686f6c61');
});

test('key message', () => {
  assert.equal(bytesToHex(remote.key(66)), '520408421003');
});

test('parse messages the TV sent', () => {
  const imeInject = new PbMessage(hexToBytes('a201210a1f621d636f6d2e676f6f676c652e616e64726f69642e74766c61756e63686572'));
  assert.ok(imeInject.has(20));
  const parsed = parseRemote(hexToBytes('a201210a1f621d636f6d2e676f6f676c652e616e64726f69642e74766c61756e63686572'));
  assert.deepEqual(parsed, { kind: 'ime_key_inject', appPackage: 'com.google.android.tvlauncher', field: null });
});

test('deframer handles split and merged chunks', () => {
  const a = frame(remote.key(66));
  const b = frame(remote.imeText('x'.repeat(200), 1, 2));
  const all = new Uint8Array([...a, ...b]);
  const d = new Deframer();
  const out: Uint8Array[] = [];
  for (let i = 0; i < all.length; i += 7) out.push(...d.push(all.subarray(i, i + 7)));
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], remote.key(66));
  assert.deepEqual(out[1], remote.imeText('x'.repeat(200), 1, 2));
});

test('pairing secret uses keys without leading zeros', () => {
  const key = { modulus: hexToBytes('00c0ffee'), exponent: hexToBytes('010001') };
  const expected = createHash('sha256')
    .update(Buffer.from('c0ffee010001c0ffee010001abcd', 'hex'))
    .digest('hex');
  assert.equal(bytesToHex(pairingSecret(key, key, '12ABCD')), expected);
});

test('diff types only what changed', () => {
  assert.deepEqual(diffText('', 'hola'), { deletes: 0, insert: 'hola' });
  assert.deepEqual(diffText('hola', 'hola m'), { deletes: 0, insert: ' m' });
  assert.deepEqual(diffText('hola mundo', 'hola'), { deletes: 6, insert: '' });
  assert.deepEqual(diffText('ola', 'hola'), { deletes: 3, insert: 'hola' });
  assert.deepEqual(diffText('te quiero', 'te quieto'), { deletes: 2, insert: 'to' });
  assert.deepEqual(diffText('😀a', '😀b'), { deletes: 1, insert: 'b' });
});

test('YouTube gets plain letters', () => {
  assert.equal(textForTv('Ñandú camión ¿qué?', true), 'Nandu camion que?');
  assert.equal(textForTv('Ñandú camión', false), 'Ñandú camión');
  assert.equal(textForTv('a b', false), 'a b');
});

test('search target follows the TV app', () => {
  assert.equal(autoTarget(''), 'youtube');
  assert.equal(autoTarget('com.google.android.tvlauncher'), 'youtube');
  assert.equal(autoTarget('com.netflix.ninja'), 'netflix');
  assert.equal(autoTarget('com.wbd.stream'), 'max');
  assert.equal(autoTarget('uy.com.antel.androidtv.veratv'), 'enter');
});

test('search links carry the text', () => {
  const link = (id: string) => SEARCH_APPS.find((a) => a.id === id)!.searchLink('ñandú 2');
  assert.equal(link('youtube'), 'https://www.youtube.com/results?search_query=%C3%B1and%C3%BA%202');
  assert.equal(link('netflix'), 'nflx://www.netflix.com/browse');
  assert.equal(link('prime'), 'https://app.primevideo.com/search?phrase=%C3%B1and%C3%BA%202');
  assert.equal(link('max'), 'https://play.max.com/search');
});

// ---------- Controller against a simulated TV ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeTvConnection extends BufferedConnection {
  written: Uint8Array[] = [];
  constructor() {
    super({ modulus: new Uint8Array([1]), exponent: new Uint8Array([1]) });
  }
  write(data: Uint8Array) {
    this.written.push(data);
  }
  close() {
    this.deliverClose(null);
  }
  tvSends(message: Uint8Array) {
    this.deliverData(frame(message));
  }
  /** What the phone sent, decoded: "text:…", "key:66", "link:…". */
  sent(): string[] {
    const d = new Deframer();
    const out: string[] = [];
    for (const chunk of this.written) {
      for (const raw of d.push(chunk)) {
        const m = new PbMessage(raw);
        if (m.has(21)) out.push(`text:${m.msg(21).msgs(3)[0].msg(2).str(3)}`);
        else if (m.has(10)) out.push(`key:${m.msg(10).num(1)}`);
        else if (m.has(90)) out.push(`link:${m.msg(90).str(1)}`);
      }
    }
    return out;
  }
}

const tvApp = (pkg: string) =>
  new PbWriter().message(20, new PbWriter().message(1, new PbWriter().string(12, pkg))).finish();

async function testController() {
  let conn!: FakeTvConnection;
  const connectedTo: string[] = [];
  const transport: Transport = {
    getClientKey: async () => ({ modulus: new Uint8Array([1]), exponent: new Uint8Array([1]) }),
    connect: async (host) => {
      connectedTo.push(host);
      return (conn = new FakeTvConnection());
    },
    browse: async () => [{ type: '_androidtvremote2._tcp', name: 'tele de prueba', host: '10.0.0.5', port: 6466, txt: {} }],
  };
  const store = new Map<string, string | null>();
  const tv = new TvController(
    transport,
    { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v) },
    { warmUpMs: 5, searchScreen: { alreadyOpenMs: [10], justOpenedMs: [20, 40], retypeGapMs: 5, giveUpMs: 500 } },
  );
  // First run: no TV saved yet. The only TV on the Wi-Fi is picked on its own.
  assert.equal(tv.getState().needsTv, true);
  tv.setActive(true);
  await sleep(10);
  assert.deepEqual(connectedTo, ['10.0.0.5']);
  assert.deepEqual([tv.getState().tvName, tv.getState().needsTv], ['tele de prueba', false]);
  assert.equal(JSON.parse(store.get('tv')!).host, '10.0.0.5');
  conn.tvSends(new PbWriter().message(1, new PbWriter().uint(1, 639)).finish()); // configure
  conn.tvSends(new PbWriter().message(2, new PbWriter()).finish()); // set_active
  conn.tvSends(new PbWriter().message(40, new PbWriter().uint(1, 1)).finish()); // start
  conn.tvSends(tvApp('com.google.android.tvlauncher'));
  await sleep(15);
  const state = () => tv.getState();
  const newSends = (() => {
    let seen = 0;
    return () => {
      const all = conn.sent().filter((s) => !s.startsWith('key:0'));
      const fresh = all.slice(seen);
      seen = all.length;
      return fresh;
    };
  })();
  newSends();

  // Home screen: YouTube by default, nothing typed live (no field to type into).
  assert.equal(state().target, 'youtube');
  tv.setText('hola');
  assert.deepEqual(newSends(), []);

  // A manual pick holds…
  tv.setTarget('netflix');
  assert.deepEqual([state().target, state().targetAuto], ['netflix', false]);
  // …until the TV opens another app.
  conn.tvSends(tvApp('com.google.android.youtube.tv'));
  assert.deepEqual([state().target, state().targetAuto], ['youtube', true]);

  // In YouTube, typing shows up live (plain letters).
  tv.setText('hola ñ');
  assert.deepEqual(newSends(), ['text:hola n']);

  // From YouTube, pick Netflix: nothing typed live in YouTube; "Buscar" only opens Netflix
  // and keeps the text (Netflix can't be opened on its search screen).
  tv.setTarget('netflix');
  tv.setText('hola ñu');
  assert.deepEqual(newSends(), []);
  const clearsBefore = state().clearToken;
  tv.submit();
  assert.deepEqual(newSends(), ['link:nflx://www.netflix.com/browse']);
  conn.tvSends(tvApp('com.netflix.ninja'));
  assert.deepEqual([state().target, state().targetAuto], ['netflix', true]);
  assert.equal(state().clearToken, clearsBefore, 'text kept while Netflix opens');
  // With Netflix open, "Escribir" types the kept text (plain letters; Netflix drops accents).
  tv.submit();
  assert.deepEqual(newSends(), ['text:hola nu']);
  // And from then on it types live.
  tv.setText('hola ñu 2');
  assert.deepEqual(newSends(), ['text: 2']);

  // HBO Max: open its search, then type once the app is in front.
  tv.setTarget('max');
  tv.setText('dark');
  tv.submit();
  assert.deepEqual(newSends(), ['link:https://play.max.com/search']);
  conn.tvSends(tvApp('com.wbd.stream'));
  await sleep(60);
  // Typed twice; the second try first deletes what the first one may have left.
  const del4 = ['key:67', 'key:67', 'key:67', 'key:67'];
  assert.deepEqual(newSends(), ['text:dark', ...del4, 'text:dark']);

  // Any other app: type live, "Enter" presses Enter.
  conn.tvSends(tvApp('uy.com.antel.androidtv.veratv'));
  assert.equal(state().target, 'enter');
  tv.setText('abc');
  tv.submit();
  assert.deepEqual(newSends(), ['text:abc', 'key:66']);

  tv.setActive(false);
}

async function asyncTest(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

async function main() {
  await asyncTest('controller: search target, live typing, search in another app', testController);
  await netTests(asyncTest);
  await brandTests(asyncTest);
  await brandTests2(asyncTest);
  await brandTests3(asyncTest);
  await resilienceTests(asyncTest);
  console.log(`\n${passed} tests passed`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
