// Sony against a fake with real sets' rules: the auth cookie expires (Max-Age 14 days), the keyboard
// query needs no auth while setTextForm does, and some sets only serve /sony/IRCC. Guards the fixes
// from comparing our client with pybravia / bravia-tv (what Home Assistant runs on real BRAVIAs).
import assert from 'node:assert/strict';

import { sony } from '../../src/brands/sony';
import { fakeSony } from './fakes/sony';
import { controllerFor, eventually, memoryStore, remapTransport } from './harness';

type Test = (name: string, fn: () => void | Promise<void>) => Promise<void>;

const TV = { brand: 'sony' as const, host: '10.0.0.12', name: 'Sony', id: 'sony-123' };
const KEY = `cred:sony:${TV.id}`;

async function setup(fakeOptions: Parameters<typeof fakeSony>[0], saved: Record<string, string>) {
  const fake = await fakeSony(fakeOptions);
  const transport = remapTransport({ '10.0.0.12:80': fake.port, '10.0.0.12:52323': fake.port });
  const store = memoryStore();
  store.set(KEY, JSON.stringify(saved));
  const { tv, state } = controllerFor(transport, [sony], store);
  tv.chooseTv(TV);
  tv.setActive(true);
  const done = () => {
    tv.setActive(false);
    fake.close();
  };
  return { fake, tv, state, store, done };
}

export async function sonyRealTests(test: Test) {
  await test('sony: an expired cookie is renewed with the saved PIN, without asking again', async () => {
    const s = await setup({ pin: '2580', cookie: 'tok-current' }, { cookie: 'tok-expired', clientId: 'TecladoTV:old', pin: '2580' });
    try {
      await eventually(() => assert.equal(s.state().connection, 'ready'), 5000);
      s.fake.openKeyboard();
      await eventually(() => assert.equal(s.state().tvKeyboard, true), 4000);
      s.tv.setText('hola');
      await eventually(() => assert.equal(s.fake.state.field, 'hola'));
      assert.equal(s.fake.state.pinsShown, 0, 'no PIN shown on the TV');
      assert.equal(JSON.parse(s.store.get(KEY)!).cookie, s.fake.state.cookie, 'the new cookie was saved');
    } finally {
      s.done();
    }
  });

  await test('sony: a dead cookie (no PIN saved) is noticed on the first text and asks to pair again', async () => {
    const s = await setup({ pin: '2580', cookie: 'tok-current' }, { cookie: 'tok-expired', clientId: 'TecladoTV:old' });
    try {
      // The keyboard query needs no auth, so the session looks fine until we write.
      await eventually(() => assert.equal(s.state().connection, 'ready'), 5000);
      s.fake.openKeyboard();
      await eventually(() => assert.equal(s.state().tvKeyboard, true), 4000);
      s.tv.setText('hola');
      await eventually(() => assert.equal(s.state().pairing?.phase, 'waiting_code'), 5000);
    } finally {
      s.done();
    }
  });

  await test('sony: Enter works on sets that only answer /sony/IRCC', async () => {
    const s = await setup({ cookie: 'tok', irccPath: 'IRCC' }, { cookie: 'tok' });
    try {
      await eventually(() => assert.equal(s.state().connection, 'ready'), 5000);
      s.tv.submit();
      await eventually(() => assert.deepEqual(s.fake.state.ircc, ['AAAAAQAAAAEAAABlAw==']), 4000);
    } finally {
      s.done();
    }
  });
}
