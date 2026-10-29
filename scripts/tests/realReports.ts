// Behaviour reported on real TVs (reference-library issues and maintainers' notes) that our first
// simulated TVs didn't model: Panasonic refusing commands from another subnet, Roku changing its
// "Control by mobile apps" setting mid-session, Roku rejecting host names.
import assert from 'node:assert/strict';

import { panasonic } from '../../src/brands/panasonic';
import { roku } from '../../src/brands/roku';
import { fakePanasonic } from './fakes/panasonic';
import { fakeRoku } from './fakes/roku';
import { controllerFor, eventually, memoryStore, remapTransport } from './harness';

type Test = (name: string, fn: () => void | Promise<void>) => Promise<void>;

export async function realReportsTests(test: Test) {
  await test('panasonic: a TV that refuses commands from another subnet (403) says so instead of failing silently', async () => {
    // Plain TV (2011-2018): the description loads, but every command would be dropped.
    const plain = await fakePanasonic({ encrypted: false, forbidPosts: true });
    const c1 = controllerFor(remapTransport({ '10.0.0.7:55000': plain.port }), [panasonic]);
    try {
      c1.tv.chooseTv({ brand: 'panasonic', host: '10.0.0.7', name: 'Living' });
      c1.tv.setActive(true);
      await eventually(() => assert.match(c1.state().problem ?? '', /misma red/), 5000);
      assert.notEqual(c1.state().connection, 'ready');
    } finally {
      c1.tv.setActive(false);
      plain.close();
    }

    // Encrypted TV (2019+) already paired: a 403 is not "the TV forgot us", so no new PIN.
    const enc = await fakePanasonic({ encrypted: true, forbidPosts: true });
    const store = memoryStore();
    store.set('cred:panasonic:Living', JSON.stringify({ appId: 'BSkeeKuuwakd9Q==', encKey: 'EarvNQodKYlj5zTEIhZoXQ==' }));
    const c2 = controllerFor(remapTransport({ '10.0.0.8:55000': enc.port }), [panasonic], store);
    try {
      c2.tv.chooseTv({ brand: 'panasonic', host: '10.0.0.8', name: 'Living', hints: { encrypted: '1' } });
      c2.tv.setActive(true);
      await eventually(() => assert.match(c2.state().problem ?? '', /misma red/), 5000);
      assert.equal(c2.state().pairing, null, 'no pairing prompt for an access block');
      assert.equal(enc.state.pinsShown, 0);
    } finally {
      c2.tv.setActive(false);
      enc.close();
    }
  });

  await test('roku: control disabled mid-session (401) is reported instead of dropping keystrokes', async () => {
    const fake = await fakeRoku({ mode: 'enabled', name: 'Tele TCL' });
    const { tv, state } = controllerFor(remapTransport({ '10.0.0.9:8060': fake.port }), [roku]);
    try {
      tv.chooseTv({ brand: 'roku', host: '10.0.0.9', name: '' });
      tv.setActive(true);
      await eventually(() => assert.equal(state().connection, 'ready'));
      tv.setText('ab');
      await eventually(() => assert.equal(fake.state.field, 'ab'));
      fake.setMode('disabled');
      tv.setText('abcd');
      await eventually(() => assert.match(state().problem ?? '', /desactivado/), 5000);
    } finally {
      tv.setActive(false);
      fake.close();
    }
  });

  await test('roku: a host name typed by hand asks for the IP (Roku refuses non-IP Host headers)', async () => {
    const fake = await fakeRoku({ mode: 'enabled' });
    const { tv, state } = controllerFor(remapTransport({ 'roku.local:8060': fake.port }), [roku]);
    try {
      tv.chooseTv({ brand: 'roku', host: 'roku.local', name: 'Roku' });
      tv.setActive(true);
      await eventually(() => assert.match(state().problem ?? '', /dirección IP/), 5000);
    } finally {
      tv.setActive(false);
      fake.close();
    }
  });
}
