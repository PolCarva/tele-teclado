// Resilience against a misbehaving TV: the app must never crash and never hang, even when a TV
// accepts the socket then goes silent, sends garbage, drops a half-finished handshake, or a
// connector fails to settle. These guard the fixes from the failure-mode audit; the happy paths
// live in brands.ts and selftest.ts.

import assert from 'node:assert/strict';

import { PairingSession } from '../../src/protocol/pairing';
import { frame } from '../../src/protocol/pb';
import { RemoteSession } from '../../src/protocol/session';
import { BufferedConnection, type Connection, type PublicKey, type Transport } from '../../src/protocol/transport';
import { PairingError, type Driver, type TvInfo, type TvSession } from '../../src/brands/types';
import { TvController, type Timing } from '../../src/tv/TvController';
import { controllerFor, eventually, memoryStore, remapTransport, sleep } from './harness';

type Test = (name: string, fn: () => void | Promise<void>) => Promise<void>;

const KEY: PublicKey = { modulus: new Uint8Array([1]), exponent: new Uint8Array([1]) };

/** A connection whose bytes and close we drive by hand (no real socket). */
class FakeConn extends BufferedConnection {
  written: Uint8Array[] = [];
  wasClosed = false;
  constructor() {
    super(KEY);
  }
  write(data: Uint8Array) {
    this.written.push(data);
  }
  close() {
    this.wasClosed = true;
    this.deliverClose(null);
  }
  /** A whole TV→phone message (length-prefixed like the wire). */
  feed(message: Uint8Array) {
    this.deliverData(frame(message));
  }
  /** Raw bytes exactly as given (to simulate a corrupt stream). */
  feedRaw(bytes: Uint8Array) {
    this.deliverData(bytes);
  }
}

function fakeTransport(onConnect: (conn: FakeConn) => void): Transport {
  return {
    getClientKey: async () => KEY,
    connect: async () => {
      const conn = new FakeConn();
      onConnect(conn);
      return conn as Connection;
    },
  };
}

const shortTiming: Timing = {
  warmUpMs: 0,
  connectWatchdogMs: 150,
  searchScreen: { alreadyOpenMs: [10], justOpenedMs: [20], retypeGapMs: 5, giveUpMs: 200 },
};

const dummySession = (): TvSession => ({
  textMode: 'insert',
  ready: true,
  closed: false,
  updateText() {},
  submit() {},
  close() {},
});

export async function resilienceTests(test: Test) {
  await test('androidtv: an oversized/garbage message from the TV does not crash the session', async () => {
    let conn!: FakeConn;
    const session = await RemoteSession.open(
      fakeTransport((c) => (conn = c)),
      '10.0.0.1',
      {},
    );
    // A ping (field 8) whose val1 is a 10-byte varint above Number.MAX_SAFE_INTEGER: it parses, but
    // building the ping response would call encodeVarint and throw — inside the socket callback.
    const oversizedPing = Uint8Array.from([0x42, 0x0b, 0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]);
    assert.doesNotThrow(() => conn.feed(oversizedPing));
    assert.equal(session.closed, false, 'the session survives a malformed message');
    // And it still handles the next, valid ping (val1 = 5) by sending a response.
    const before = conn.written.length;
    conn.feed(Uint8Array.from([0x42, 0x02, 0x08, 0x05]));
    assert.ok(conn.written.length > before, 'the session keeps working after the bad message');
    session.close();
  });

  await test('androidtv: a corrupt pairing stream ends cleanly instead of crashing', async () => {
    let conn!: FakeConn;
    const started = PairingSession.start(fakeTransport((c) => (conn = c)), '10.0.0.1', 'Teclado TV');
    let rejected = false;
    started.then(
      (s) => s.cancel(),
      () => (rejected = true),
    );
    await sleep(5); // let start() wire the connection and send its request
    // A length prefix that is an endless varint: the deframer throws. It must not escape onData.
    assert.doesNotThrow(() => conn.feedRaw(Uint8Array.from(new Array(12).fill(0xff))));
    await eventually(() => {
      assert.equal(rejected, true, 'pairing rejected rather than hung');
      assert.equal(conn.wasClosed, true, 'the pairing socket was closed');
    });
  });

  await test('controller: a connector whose connect() never settles does not wedge the app', async () => {
    const hanging: Driver = {
      brand: 'androidtv',
      label: 'Test TV',
      priority: 100,
      textMode: 'insert',
      discovery: {},
      connect: () => new Promise<{ session: TvSession }>(() => {}), // never resolves or rejects
    };
    const tv = new TvController(remapTransport({}), memoryStore(), shortTiming, [hanging]);
    tv.chooseTv({ brand: 'androidtv', host: '10.0.0.20', name: 'Test TV' });
    tv.setActive(true);
    // Without the watchdog, opening stays true forever and the UI sits on 'connecting'. With it,
    // the stuck attempt is dropped and retried, so it reaches the normal offline/retry state.
    await eventually(() => assert.equal(tv.getState().connection, 'offline'), 3000);
    tv.setActive(false);
  });

  await test('controller: a transient connect timeout on an already-paired TV retries, not fails', async () => {
    let attempts = 0;
    const flaky: Driver = {
      brand: 'roku',
      label: 'Test',
      priority: 50,
      textMode: 'insert',
      discovery: {},
      connect: async () => {
        attempts += 1;
        if (attempts === 1) throw new PairingError('No hubo respuesta en la tele', 'timeout');
        return { session: dummySession() };
      },
    };
    const store = memoryStore();
    const chosen: TvInfo = { brand: 'roku', host: '10.0.0.21', name: 'Test TV' };
    store.set(`cred:roku:${chosen.name}`, JSON.stringify({ x: '1' })); // already paired
    const tv = new TvController(remapTransport({}), store, shortTiming, [flaky]);
    tv.chooseTv(chosen);
    tv.setActive(true);
    // A terminal 'failed' here would be the bug; the transient timeout should retry and connect.
    await eventually(() => assert.equal(tv.getState().connection, 'ready'), 4000);
    assert.ok(attempts >= 2, 'it retried after the transient timeout');
    tv.setActive(false);
  });

  await test('sony: a TV that goes silent after connecting is noticed and recovers', async () => {
    const { fakeSony } = await import('./fakes/sony');
    const { sony } = await import('../../src/brands/sony');
    const fake = await fakeSony({ cookie: 'tok-test', name: 'KDL-50W805' });
    const transport = remapTransport({ '10.0.0.12:80': fake.port, '10.0.0.12:52323': fake.port });
    const store = memoryStore();
    store.set('cred:sony:sony-123', JSON.stringify({ cookie: 'tok-test' }));
    const { tv, state } = controllerFor(transport, [sony], store);
    tv.chooseTv({ brand: 'sony', host: '10.0.0.12', name: 'Sony', id: 'sony-123' });
    tv.setActive(true);
    await eventually(() => assert.equal(state().connection, 'ready'), 5000);
    // The TV disappears (powered off). The keyboard poll is the only liveness signal: it must
    // surface the loss instead of polling a dead session forever.
    fake.close();
    await eventually(() => assert.notEqual(state().connection, 'ready'), 10000);
    tv.setActive(false);
  });

  await test('lg: the TV dropping the socket mid-registration fails fast, not after 60s', async () => {
    const { fakeLg } = await import('./fakes/lg');
    const { lg } = await import('../../src/brands/lg');
    const fake = await fakeLg({ dropOnRegister: true, name: 'LG' });
    const transport = remapTransport({ '10.0.0.22:3001': fake.port });
    const { tv, state } = controllerFor(transport, [lg]);
    tv.chooseTv({ brand: 'lg', host: '10.0.0.22', name: 'LG', hints: { secure: 'yes' } });
    tv.setActive(true);
    // The register promise used to sit on its own 60s timeout; now the socket close fails it at once.
    await eventually(() => assert.equal(state().pairing?.phase, 'failed'), 4000);
    tv.setActive(false);
    fake.close();
  });

  await test('lg: a TV that goes to standby without closing the socket is noticed (heartbeat)', async () => {
    const net = await import('node:net');
    const { fakeLg } = await import('./fakes/lg');
    const { lg, lgKeepAlive } = await import('../../src/brands/lg');
    const fake = await fakeLg({ name: 'LG' });
    // A proxy that can stop passing bytes while keeping both sockets open: a TV in standby.
    let blackhole = false;
    const proxy = net.createServer((client) => {
      const up = net.connect(fake.port, '127.0.0.1');
      client.on('data', (d) => void (!blackhole && up.write(d)));
      up.on('data', (d) => void (!blackhole && client.write(d)));
      const end = () => (client.destroy(), up.destroy());
      for (const s of [client, up]) (s.on('close', end), s.on('error', end));
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const saved = { ...lgKeepAlive };
    Object.assign(lgKeepAlive, { everyMs: 100, maxIdleMs: 300 });
    const transport = remapTransport({ '10.0.0.24:3001': (proxy.address() as import('node:net').AddressInfo).port });
    const { tv, state } = controllerFor(transport, [lg]);
    try {
      tv.chooseTv({ brand: 'lg', host: '10.0.0.24', name: 'LG', hints: { secure: 'yes' } });
      tv.setActive(true);
      await eventually(() => assert.equal(state().connection, 'ready'), 5000);
      await sleep(400); // pings get answered: still connected
      assert.equal(state().connection, 'ready');
      blackhole = true;
      // Without the heartbeat the app stays 'ready' (typing into the void) until the OS gives up, minutes later.
      await eventually(() => assert.notEqual(state().connection, 'ready'), 3000);
      blackhole = false;
      await eventually(() => assert.equal(state().connection, 'ready'), 8000);
    } finally {
      Object.assign(lgKeepAlive, saved);
      tv.setActive(false);
      proxy.close();
      fake.close();
    }
  });

  await test('lg: coming back to the app does not type the field twice', async () => {
    const { fakeLg } = await import('./fakes/lg');
    const { lg } = await import('../../src/brands/lg');
    const fake = await fakeLg({ name: 'LG' });
    const { tv, state } = controllerFor(remapTransport({ '10.0.0.25:3001': fake.port }), [lg]);
    try {
      tv.chooseTv({ brand: 'lg', host: '10.0.0.25', name: 'LG', hints: { secure: 'yes' } });
      tv.setActive(true);
      await eventually(() => assert.equal(state().connection, 'ready'), 5000);
      fake.openKeyboard();
      await eventually(() => assert.equal(state().tvKeyboard, true));
      tv.setText('hola');
      await eventually(() => assert.equal(fake.state.field, 'hola'));
      // Background and back: the new session re-subscribes and the TV says the field is still focused.
      tv.setActive(false);
      tv.setActive(true);
      await eventually(() => assert.equal(state().connection, 'ready'), 5000);
      await sleep(200);
      tv.setText('hola!');
      await eventually(() => assert.equal(fake.state.field, 'hola!'));
      await sleep(150);
      assert.equal(fake.state.field, 'hola!');
    } finally {
      tv.setActive(false);
      fake.close();
    }
  });

  await test('samsung: cancelling the pairing closes the socket right away', async () => {
    const { fakeSamsung } = await import('./fakes/samsung');
    const { samsung } = await import('../../src/brands/samsung');
    const fake = await fakeSamsung({ token: true, requirePrompt: true, holdPrompt: true, name: 'Samsung' });
    const transport = remapTransport({ '10.0.0.23:8001': fake.port, '10.0.0.23:8002': fake.port });
    const { tv, state } = controllerFor(transport, [samsung]);
    tv.chooseTv({ brand: 'samsung', host: '10.0.0.23', name: 'Samsung', hints: { token: 'yes' } });
    tv.setActive(true);
    // No token yet: the TV shows the Allow prompt and (holdPrompt) never answers.
    await eventually(() => assert.equal(state().pairing?.phase, 'waiting_accept'), 5000);
    await eventually(() => assert.equal(fake.state.openSockets, 1));
    // Backgrounding cancels the pairing; the in-flight socket must close now, not linger for 60s.
    tv.setActive(false);
    await eventually(() => assert.equal(fake.state.openSockets, 0), 3000);
    fake.close();
  });
}
