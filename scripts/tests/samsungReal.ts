// Samsung against a fake that reports IME events the way real TVs do: imeStart, imeDone, an imeUpdate
// with the field's starting text ("" when empty, always "" in password fields), and an echo after
// every change. Guards the fix for text typed ahead or in password fields being wiped by those updates.
import assert from 'node:assert/strict';

import { samsung } from '../../src/brands/samsung';
import { fakeSamsung } from './fakes/samsung';
import { controllerFor, eventually, memoryStore, remapTransport, sleep } from './harness';

type Test = (name: string, fn: () => void | Promise<void>) => Promise<void>;

async function setup(echoMs = 30) {
  const fake = await fakeSamsung({ token: true, echoMs });
  const transport = remapTransport({ '10.0.0.10:8002': fake.port });
  const store = memoryStore();
  store.set('cred:samsung:uuid:aa-bb', JSON.stringify({ token: '85418879' }));
  const { tv, state } = controllerFor(transport, [samsung], store);
  // The phone box, as TypingView does it: remoteText replaces it, keystrokes edit it.
  const ui = { box: '', resets: [] as string[], token: 0 };
  tv.subscribe((s) => {
    if (s.remoteText && s.remoteText.token !== ui.token) {
      ui.token = s.remoteText.token;
      if (s.remoteText.text !== ui.box) ui.resets.push(`${JSON.stringify(ui.box)}->${JSON.stringify(s.remoteText.text)}`);
      ui.box = s.remoteText.text;
    }
  });
  const type = (text: string) => {
    ui.box = text;
    tv.setText(text);
  };
  return { fake, tv, state, ui, type, connect: async () => {
    tv.chooseTv({ brand: 'samsung', host: '10.0.0.10', name: 'Samsung', id: 'uuid:aa-bb', hints: { token: 'yes' } });
    tv.setActive(true);
    await eventually(() => assert.equal(state().connection, 'ready'), 5000);
  } };
}

export async function samsungRealTests(test: Test) {
  await test('samsung(real IME order): text typed before the field opens is not wiped by the empty imeUpdate', async () => {
    const s = await setup();
    await s.connect();
    s.type('hola');
    await sleep(60);
    s.fake.openKeyboard();
    await sleep(15); // before the TV's echo of our text
    s.type(s.ui.box + '!');
    await sleep(200);
    try {
      assert.deepEqual(s.ui.resets, []);
      assert.equal(s.fake.state.field, 'hola!');
    } finally {
      s.tv.setActive(false);
      s.fake.close();
    }
  });

  await test('samsung(real IME order): password field (imeUpdate always "") keeps every keystroke', async () => {
    const s = await setup(30);
    await s.connect();
    s.fake.openKeyboard('', 'password');
    await eventually(() => assert.equal(s.state().tvKeyboard, true));
    for (const ch of Array.from('hola ñandú 2')) {
      s.type(s.ui.box + ch);
      await sleep(60);
    }
    await sleep(150);
    try {
      assert.equal(s.fake.state.field, 'hola ñandú 2', `box resets: ${s.ui.resets.join(', ')}`);
      assert.equal(s.ui.box, 'hola ñandú 2');
    } finally {
      s.tv.setActive(false);
      s.fake.close();
    }
  });

  await test('samsung(real IME order): a slow echo of our own text does not make the box jump back', async () => {
    const s = await setup(200);
    await s.connect();
    s.fake.openKeyboard();
    await eventually(() => assert.equal(s.state().tvKeyboard, true));
    for (const ch of Array.from('hola ñandú 2')) {
      s.type(s.ui.box + ch);
      await sleep(50);
    }
    await sleep(400);
    try {
      assert.equal(s.fake.state.field, 'hola ñandú 2', `box resets: ${s.ui.resets.join(', ')}`);
      assert.equal(s.ui.box, 'hola ñandú 2');
    } finally {
      s.tv.setActive(false);
      s.fake.close();
    }
  });

  await test('samsung(real IME order): a field that already has text still fills the box', async () => {
    const s = await setup();
    await s.connect();
    s.fake.openKeyboard('yakult');
    await eventually(() => assert.equal(s.ui.box, 'yakult'));
    s.type('yakult 2');
    await eventually(() => assert.equal(s.fake.state.field, 'yakult 2'));
    await sleep(150);
    try {
      assert.equal(s.ui.box, 'yakult 2');
    } finally {
      s.tv.setActive(false);
      s.fake.close();
    }
  });

  await test('samsung(real IME order): typing ahead into a field that already has text keeps what was typed', async () => {
    const s = await setup();
    await s.connect();
    s.type('google.com');
    await sleep(60);
    s.fake.openKeyboard('https://www.samsung.com/', 'url');
    await sleep(100);
    s.type(s.ui.box + '/');
    await sleep(150);
    try {
      assert.equal(s.fake.state.field, 'google.com/', `box resets: ${s.ui.resets.join(', ')}`);
      assert.equal(s.ui.box, 'google.com/');
    } finally {
      s.tv.setActive(false);
      s.fake.close();
    }
  });

  await test('samsung(real IME order): text typed with the TV remote shows up in the box', async () => {
    const s = await setup();
    await s.connect();
    s.fake.openKeyboard();
    await eventually(() => assert.equal(s.state().tvKeyboard, true));
    await sleep(60);
    s.fake.tvTypes('star wa');
    await eventually(() => assert.equal(s.ui.box, 'star wa'));
    s.type(s.ui.box + 'rs');
    await sleep(150);
    try {
      assert.equal(s.fake.state.field, 'star wars');
    } finally {
      s.tv.setActive(false);
      s.fake.close();
    }
  });

  await test('samsung(real IME order): keyboard already open when the phone connects', async () => {
    const s = await setup();
    s.fake.keyboardAlreadyOpen();
    await s.connect();
    s.type('hola');
    await sleep(200);
    try {
      assert.equal(s.fake.state.field, 'hola');
    } finally {
      s.tv.setActive(false);
      s.fake.close();
    }
  });
}
