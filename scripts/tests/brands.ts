// Each brand's connector against a simulated TV built from the protocol sources.

import assert from 'node:assert/strict';

import { panasonic, pairingKeys, seal, sessionKeys } from '../../src/brands/panasonic';
import { base64Decode, bytesToHex } from '../../src/protocol/bytes';
import { fakePanasonic } from './fakes/panasonic';
import { controllerFor, eventually, memoryStore, remapTransport } from './harness';

type Test = (name: string, fn: () => void | Promise<void>) => Promise<void>;

export async function brandTests(test: Test) {
  await test('panasonic: crypto matches published known-answer vectors', () => {
    const keys = pairingKeys(base64Decode('mUQdS7/RyJTMsiojPz9i1Q=='));
    assert.equal(bytesToHex(keys.iv), '99441d4bbfd1c894ccb22a233f3f62d5');
    assert.equal(bytesToHex(keys.aesKey), 'b4e2bb666b372e40dcd54d332a9dc0c0');
    assert.equal(bytesToHex(keys.hmacKey), '0882c386781e183a640143337ce1ef70b8003e98640cc62ba0ee6f4e469a076b');
    const header = Uint8Array.from({ length: 12 }, (_, i) => i);
    assert.equal(
      seal(keys, '<X_PinCode>4410</X_PinCode>', header),
      '/Ird4/R7cLUCCJzX7SW4xOtGK6gDteDRWuZGkDVkauZYBdCW8DB3pDKk3jW1l7lz5DRWmqNPnXvwRYUN1bh0QWgSh1YBIWDiUVuCmEKHvAY=',
    );
    const session = sessionKeys(base64Decode('EarvNQodKYlj5zTEIhZoXQ=='));
    assert.equal(bytesToHex(session.iv), '11aaef350a1d298963e734c42216685d');
    assert.equal(bytesToHex(session.aesKey), 'ef3511aa29890a1d34c463e7685d2216');
    assert.equal(
      seal(session, '<X_ApplicationId>BSkeeKuuwakd9Q==</X_ApplicationId>', header),
      'wBKVZHZxb//8lF1i0JhAjpavNoTFDduTZnTtMYCvqDMohddXstQMyPbSID7xb1dBZZGTncGM5ZTs2Ju6b/m4EzS/GvpnCSxy03ql+chykogXUgvH5cG1J5gGC5p9TeVlLoNTC4UbVPdQjnBkbu7dtA==',
    );
  });

  await test('panasonic (plain, 2011-2018): found by SSDP, "Enviar" sends the draft, Enter key', async () => {
    const fake = await fakePanasonic({ encrypted: false });
    const transport = remapTransport(
      { '10.0.0.7:55000': fake.port },
      { ssdp: [{ host: '10.0.0.7', response: 'HTTP/1.1 200 OK\r\nST: urn:panasonic-com:device:p00RemoteController:1\r\nLOCATION: http://10.0.0.7:55000/nrc/ddd.xml\r\n\r\n' }] },
    );
    const { tv, state } = controllerFor(transport, [panasonic]);
    tv.setActive(true);
    await eventually(() => assert.equal(state().connection, 'ready'));
    assert.deepEqual([state().tv?.brand, state().tvName, state().tv?.model, state().compose], ['panasonic', '49DX600 Series', 'TX-49DX600EA', true]);
    tv.setText('hola ñandú & <amigos>');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(fake.state.field, '', 'nothing typed live on append-only TVs');
    tv.submit();
    await eventually(() => assert.equal(fake.state.field, 'hola ñandú & <amigos>'));
    tv.pressEnter();
    await eventually(() => assert.deepEqual(fake.state.keys, ['NRC_ENTER-ONOFF']));
    tv.setActive(false);
    fake.close();
  });

  await test('panasonic (encrypted, 2019+): PIN pairing, encrypted text, new session after power loss', async () => {
    const fake = await fakePanasonic({ encrypted: true, pin: '4821' });
    const transport = remapTransport({ '10.0.0.8:55000': fake.port });
    const { tv, state, store } = controllerFor(transport, [panasonic]);
    tv.chooseTv({ brand: 'panasonic', host: '10.0.0.8', name: 'Living' });
    tv.setActive(true);
    await eventually(() => assert.equal(state().pairing?.phase, 'waiting_code'));
    assert.deepEqual([state().pairing?.prompt?.kind, (state().pairing?.prompt as { length: number }).length], ['code', 4]);
    await tv.submitCode('0000');
    assert.equal(state().pairing?.phase, 'waiting_code');
    assert.match(state().pairing?.error ?? '', /no coincide/);
    assert.equal(fake.state.pinsShown, 2, 'a wrong PIN asks the TV for a new one');
    await tv.submitCode('4821');
    await eventually(() => assert.equal(state().connection, 'ready'));
    assert.ok([...store.map.keys()].some((k) => k.startsWith('cred:panasonic:')), 'keys saved');
    tv.setText('Matrix');
    tv.submit();
    await eventually(() => assert.equal(fake.state.field, 'Matrix'));
    fake.dropSession();
    tv.setText(' 2');
    tv.submit();
    await eventually(() => assert.equal(fake.state.field, 'Matrix 2'));
    assert.deepEqual(fake.state.errors, []);
    tv.setActive(false);
    fake.close();
  });
}

export async function brandTests2(test: Test) {
  const { roku } = await import('../../src/brands/roku');
  const { samsung } = await import('../../src/brands/samsung');
  const { lg } = await import('../../src/brands/lg');
  const { fakeRoku } = await import('./fakes/roku');
  const { fakeSamsung } = await import('./fakes/samsung');
  const { fakeLg } = await import('./fakes/lg');

  await test('roku: per-character typing, backspace diff, Enter; Limited mode asks for a setting', async () => {
    // Limited mode: the controller surfaces the setup message instead of connecting.
    const limited = await fakeRoku({ mode: 'limited' });
    const t1 = remapTransport({ '10.0.0.9:8060': limited.port });
    const c1 = controllerFor(t1, [roku]);
    c1.tv.chooseTv({ brand: 'roku', host: '10.0.0.9', name: 'TCL' });
    c1.tv.setActive(true);
    await eventually(() => assert.match(c1.state().problem ?? '', /Control por apps/));
    c1.tv.setActive(false);
    limited.close();

    // Enabled mode: live per-character typing, diff-based backspace, Enter.
    const fake = await fakeRoku({ mode: 'enabled', name: 'Tele TCL' });
    const transport = remapTransport({ '10.0.0.9:8060': fake.port });
    const { tv, state } = controllerFor(transport, [roku]);
    tv.chooseTv({ brand: 'roku', host: '10.0.0.9', name: '' });
    tv.setActive(true);
    await eventually(() => assert.equal(state().connection, 'ready'));
    assert.deepEqual([state().tvName, state().appLinks, state().compose], ['Tele TCL', false, false]);
    tv.setText('hola');
    await eventually(() => assert.equal(fake.state.field, 'hola'));
    tv.setText('hóla ñ');
    await eventually(() => assert.equal(fake.state.field, 'hóla ñ'));
    tv.setText('hóla');
    await eventually(() => assert.equal(fake.state.field, 'hóla'));
    tv.submit();
    await eventually(() => assert.deepEqual(fake.state.keys, ['Enter']));
    tv.setActive(false);
    fake.close();
  });

  await test('samsung: Allow-prompt pairing, token reuse, whole-field typing while the keyboard is open', async () => {
    const fake = await fakeSamsung({ token: true, requirePrompt: true, name: 'Samsung Living' });
    const transport = remapTransport({ '10.0.0.10:8001': fake.port, '10.0.0.10:8002': fake.port });
    const { tv, state, store } = controllerFor(transport, [samsung]);
    tv.chooseTv({ brand: 'samsung', host: '10.0.0.10', name: 'Samsung Living', hints: { token: 'yes' } });
    tv.setActive(true);
    // No token yet: the TV shows an Allow prompt; the fake accepts and returns one.
    await eventually(() => assert.equal(state().connection, 'ready'), 5000);
    assert.ok([...store.map.keys()].some((k) => k.startsWith('cred:samsung:')), 'token saved');
    // Typing does nothing until the TV's keyboard is open.
    tv.setText('hola');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(fake.state.field, '');
    fake.openKeyboard();
    await eventually(() => assert.equal(state().tvKeyboard, true));
    await eventually(() => assert.equal(fake.state.field, 'hola'));
    // Replace semantics: editing resends the whole string.
    tv.setText('hola mundo');
    await eventually(() => assert.equal(fake.state.field, 'hola mundo'));
    tv.submit();
    await eventually(() => assert.equal(fake.state.inputEnds, 1));
    tv.setActive(false);
    fake.close();
  });

  await test('samsung: the TV tells us its field already has text, and the box follows', async () => {
    const fake = await fakeSamsung({ token: true });
    const transport = remapTransport({ '10.0.0.10:8002': fake.port });
    const store = memoryStore();
    store.set('cred:samsung:uuid:aa-bb', JSON.stringify({ token: '85418879' }));
    const { tv, state } = controllerFor(transport, [samsung], store);
    tv.chooseTv({ brand: 'samsung', host: '10.0.0.10', name: 'Samsung', id: 'uuid:aa-bb', hints: { token: 'yes' } });
    tv.setActive(true);
    await eventually(() => assert.equal(state().connection, 'ready'), 5000);
    fake.openKeyboard('yakult');
    await eventually(() => assert.equal(state().remoteText?.text, 'yakult'));
    tv.setActive(false);
    fake.close();
  });

  await test('lg: prompt pairing + client-key reuse, insert/delete typing, Enter', async () => {
    const fake = await fakeLg({ name: 'LG OLED' });
    const transport = remapTransport({ '10.0.0.11:3001': fake.port });
    const store = memoryStore();
    const { tv, state } = controllerFor(transport, [lg], store);
    tv.chooseTv({ brand: 'lg', host: '10.0.0.11', name: 'LG OLED', hints: { secure: 'yes' } });
    tv.setActive(true);
    await eventually(() => assert.equal(state().connection, 'ready'), 6000);
    const key = [...store.map.entries()].find(([k]) => k.startsWith('cred:lg:'));
    assert.ok(key && JSON.parse(key[1]!).clientKey, 'client-key saved');
    // Typing only lands while a field is focused.
    fake.openKeyboard();
    await eventually(() => assert.equal(state().tvKeyboard, true));
    tv.setText('hola');
    await eventually(() => assert.equal(fake.state.field, 'hola'));
    tv.setText('ho');
    await eventually(() => assert.equal(fake.state.field, 'ho'));
    tv.setText('hola ñandú');
    await eventually(() => assert.equal(fake.state.field, 'hola ñandú'));
    tv.submit();
    await eventually(() => assert.equal(fake.state.entered, 1));
    tv.setActive(false);
    fake.close();
  });
}

export async function brandTests3(test: Test) {
  const { sony } = await import('../../src/brands/sony');
  const { fakeSony } = await import('./fakes/sony');

  await test('sony: SSDP + PIN pairing, cookie reuse, setTextForm while the keyboard is up, IRCC Enter', async () => {
    const fake = await fakeSony({ pin: '2580', name: 'KDL-50W805' });
    const transport = remapTransport(
      { '10.0.0.12:80': fake.port, '10.0.0.12:52323': fake.port },
      { ssdp: [{ host: '10.0.0.12', response: 'HTTP/1.1 200 OK\r\nST: urn:schemas-sony-com:service:ScalarWebAPI:1\r\nSERVER: Sony\r\nLOCATION: http://10.0.0.12:52323/dmr.xml\r\n\r\n' }] },
    );
    const { tv, state, store } = controllerFor(transport, [sony]);
    tv.setActive(true);
    await eventually(() => assert.equal(state().pairing?.phase, 'waiting_code'), 5000);
    assert.equal((state().pairing?.prompt as { length: number }).length, 4);
    await tv.submitCode('0000');
    assert.match(state().pairing?.error ?? '', /no coincide/);
    await tv.submitCode('2580');
    await eventually(() => assert.equal(state().connection, 'ready'), 5000);
    assert.ok([...store.map.keys()].some((k) => k.startsWith('cred:sony:')), 'cookie saved');
    assert.equal(state().compose, false);
    // Typing waits for the TV's software keyboard.
    tv.setText('hola');
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(fake.state.field, '');
    fake.openKeyboard();
    await eventually(() => assert.equal(state().tvKeyboard, true), 4000);
    await eventually(() => assert.equal(fake.state.field, 'hola'));
    tv.setText('hola mundo');
    await eventually(() => assert.equal(fake.state.field, 'hola mundo'));
    tv.submit();
    await eventually(() => assert.ok(fake.state.ircc.length >= 1));
    tv.setActive(false);
    fake.close();
  });
}
