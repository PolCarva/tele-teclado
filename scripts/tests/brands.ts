// Each brand's connector against a simulated TV built from the protocol sources.

import assert from 'node:assert/strict';

import { panasonic, pairingKeys, seal, sessionKeys } from '../../src/brands/panasonic';
import { base64Decode, bytesToHex } from '../../src/protocol/bytes';
import { fakePanasonic } from './fakes/panasonic';
import { controllerFor, eventually, memoryStore, remapTransport, sleep } from './harness';

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

export async function brandTests4(test: Test) {
  const { fireTv } = await import('../../src/brands/firetv');
  const { discoverTvs, identifyHost } = await import('../../src/brands/discovery');
  const { fakeFireTv, FAKE_FIRETV_UUID } = await import('./fakes/firetv');
  const dialReply = (from: string, location: string) => ({
    host: from,
    response: `HTTP/1.1 200 OK\r\nST: urn:dial-multiscreen-org:service:dial:1\r\nUSN: uuid:x::urn:dial-multiscreen-org:service:dial:1\r\nLOCATION: ${location}\r\nCACHE-CONTROL: max-age=1800\r\n\r\n`,
  });

  await test('firetv: DIAL discovery (Amazon AFT only), wake + PIN pairing, draft sent whole once a field opens, no delete or Enter', async () => {
    const fake = await fakeFireTv({ asleep: true, pin: '4826' });
    const transport = remapTransport(
      { '10.0.0.13:8080': fake.port, '10.0.0.13:8009': fake.dialPort, '10.0.0.13:49152': fake.dialPort, '10.0.0.20:8008': fake.dialPort },
      {
        ssdp: [
          dialReply('10.0.0.13', 'http://10.0.0.13:49152/dd.xml'),
          // A Chromecast also answers DIAL searches: its description isn't Amazon.
          dialReply('10.0.0.20', 'http://10.0.0.20:8008/other.xml'),
          // A reply whose description lives on another address is ignored.
          dialReply('10.0.0.21', 'http://10.0.0.13:49152/dd.xml'),
        ],
      },
    );
    const { tv, state, store } = controllerFor(transport, [fireTv]);
    tv.setActive(true);
    // One TV found: the controller picks it, finds no token and asks the TV for a PIN (waking it first).
    await eventually(() => assert.equal(state().pairing?.phase, 'waiting_code'), 6000);
    assert.deepEqual(
      [state().tv?.brand, state().tv?.host, state().tvName, state().tv?.model, state().tv?.id],
      ['firetv', '10.0.0.13', 'Fire TV Living', 'AFTMA08C15', FAKE_FIRETV_UUID],
    );
    assert.ok(fake.state.wakes >= 1, 'DIAL woke the remote service');
    assert.equal(fake.state.friendlyName, 'Teclado TV');
    assert.deepEqual([state().pairing?.prompt?.kind, (state().pairing?.prompt as { length: number }).length], ['code', 4]);
    await tv.submitCode('0000');
    assert.equal(state().pairing?.phase, 'waiting_code');
    assert.match(state().pairing?.error ?? '', /no coincide/);
    assert.equal(fake.state.pinsShown, 1, 'a wrong PIN keeps the same code on the TV');
    await tv.submitCode('4826');
    await eventually(() => assert.equal(state().connection, 'ready'), 5000);
    const saved = [...store.map.entries()].find(([k]) => k.startsWith('cred:firetv:'));
    assert.ok(saved && JSON.parse(saved[1]!).token, 'token saved');
    assert.deepEqual([state().compose, state().canSubmit, state().reportsKeyboard], [true, false, true]);
    await eventually(() => assert.equal(state().tvKeyboard, false));

    // The box is a draft: typing and deleting stay on the phone.
    tv.setText('Matrixx');
    tv.setText('Matrix');
    await sleep(100);
    assert.deepEqual(fake.state.textPosts, [], 'nothing typed live');
    // "Enviar" with no field open on the TV: the text waits (the TV would answer 200 and drop it).
    tv.submit();
    await sleep(200);
    assert.deepEqual([fake.state.textPosts, fake.state.dropped], [[], []]);
    fake.openKeyboard();
    await eventually(() => assert.equal(fake.state.field, 'Matrix'), 4000);
    assert.equal(state().tvKeyboard, true);
    assert.equal(state().remoteText, null, "the field's text from GET /keyboard is not pulled into the box");
    // The next draft goes as one more whole string (accents as UTF-8 JSON; unconfirmed on hardware).
    tv.setText(' 2 ñandú');
    tv.submit();
    await eventually(() => assert.equal(fake.state.field, 'Matrix 2 ñandú'));
    assert.deepEqual(fake.state.textPosts, ['Matrix', ' 2 ñandú'], 'one request per draft, never per letter');
    // No Enter: nothing is pressed on the TV.
    tv.pressEnter();
    await sleep(150);
    assert.deepEqual(fake.state.keys, []);
    assert.deepEqual([fake.state.obsolete, fake.state.badRequests], [0, []]);
    tv.setActive(false);

    // Same phone later: the saved token connects without a PIN.
    const again = controllerFor(transport, [fireTv], store);
    again.tv.chooseTv(state().tv!);
    again.tv.setActive(true);
    await eventually(() => assert.equal(again.state().connection, 'ready'), 5000);
    assert.equal(fake.state.pinsShown, 1);
    // The token stops working (phone removed on the TV): the app asks for a new PIN.
    fake.revoke();
    await eventually(() => assert.equal(again.state().pairing?.phase, 'waiting_code'), 6000);
    assert.equal(fake.state.pinsShown, 2);
    again.tv.setActive(false);
    fake.close();
  });

  await test('firetv: mDNS and by-address discovery, keys, no delete, wakes a sleeping service', async () => {
    const fake = await fakeFireTv();
    const transport = remapTransport(
      { '10.0.0.13:8080': fake.port, '10.0.0.13:8009': fake.dialPort, '10.0.0.13:49152': fake.dialPort },
      {
        mdns: [{ type: '_amzn-fireTv._tcp', name: 'Fire TV Cube', host: '10.0.0.14', port: 8080, txt: {} }],
        ssdp: [dialReply('10.0.0.13', 'http://10.0.0.13:49152/dd.xml')],
      },
    );
    const ctx = { transport, clientName: 'Teclado TV' };
    const found = await discoverTvs(ctx, [fireTv], { timeoutMs: 300 });
    assert.deepEqual(
      found.map((t) => [t.brand, t.host, t.name]),
      [
        ['firetv', '10.0.0.14', 'Fire TV Cube'],
        ['firetv', '10.0.0.13', 'Fire TV Living'],
      ],
    );
    // Typed address: DIAL's port is open, and the description says Amazon.
    assert.equal((await identifyHost(ctx, [fireTv], '10.0.0.13'))?.brand, 'firetv');

    // Pair straight through the connector.
    const flow = await fireTv.startPairing!({ brand: 'firetv', host: '10.0.0.13', name: 'Fire TV' }, ctx);
    const credentials = await flow.submit!('4826');
    const keyboards: boolean[] = [];
    const closes: string[] = [];
    const { session } = await fireTv.connect(
      { brand: 'firetv', host: '10.0.0.13', name: 'Fire TV' },
      credentials,
      { onClose: (reason) => closes.push(reason), onKeyboard: (k) => keyboards.push(k.visible) },
      ctx,
    );
    // Remote keys from the sources: D-pad/Select as keyDown + keyUp, Home/Back as a plain press.
    session.sendKey!('enter');
    session.sendKey!('up');
    session.sendKey!('home');
    await eventually(() => assert.deepEqual(fake.state.keys, ['select:keyDown', 'select:keyUp', 'dpad_up:keyDown', 'dpad_up:keyUp', 'home']));
    session.submit();
    // Deleting can't reach the TV: nothing is sent.
    session.updateText('abc', 'ab');
    await sleep(150);
    assert.equal(fake.state.keys.length, 5);
    assert.deepEqual(fake.state.textPosts, []);
    // The service went to sleep: the next request wakes it through DIAL and goes through.
    fake.openKeyboard();
    const wakes = fake.state.wakes;
    await fake.sleepService();
    session.updateText('', 'hola');
    await eventually(() => assert.equal(fake.state.field, 'hola'), 6000);
    assert.ok(fake.state.wakes > wakes, 'woken again');
    assert.deepEqual(closes, []);
    assert.equal(keyboards.at(-1), true);
    session.close();
    fake.close();
  });
}
