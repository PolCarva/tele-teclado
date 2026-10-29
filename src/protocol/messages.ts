// Messages of the Android TV Remote protocol v2.
// Field numbers come from polo.proto (pairing, port 6467) and remotemessage.proto
// (commands, port 6466), as published in github.com/tronikos/androidtvremote2.

import { bytesToHex } from './bytes';
import { PbMessage, PbWriter } from './pb';

// ---------- Pairing (polo) ----------

const POLO_PROTOCOL_VERSION = 2;
export const POLO_STATUS_OK = 200;
const ENCODING_HEXADECIMAL = 3;
const CODE_LENGTH = 6;
const ROLE_INPUT = 1;

function poloMessage(build: (w: PbWriter) => void): Uint8Array {
  const w = new PbWriter().uint(1, POLO_PROTOCOL_VERSION).uint(2, POLO_STATUS_OK);
  build(w);
  return w.finish();
}

const hexEncoding = () => new PbWriter().uint(1, ENCODING_HEXADECIMAL).uint(2, CODE_LENGTH);

export const polo = {
  pairingRequest: (clientName: string) =>
    poloMessage((w) => w.message(10, new PbWriter().string(1, 'atvremote').string(2, clientName))),
  options: () =>
    poloMessage((w) => w.message(20, new PbWriter().message(1, hexEncoding()).uint(3, ROLE_INPUT))),
  configuration: () =>
    poloMessage((w) => w.message(30, new PbWriter().message(1, hexEncoding()).uint(2, ROLE_INPUT))),
  secret: (secret: Uint8Array) => poloMessage((w) => w.message(40, new PbWriter().bytes(1, secret))),
};

export type PoloIn = {
  status: number;
  kind: 'pairing_request_ack' | 'options' | 'configuration_ack' | 'secret_ack' | 'other';
};

export function parsePolo(buf: Uint8Array): PoloIn {
  const m = new PbMessage(buf);
  const status = m.num(2);
  if (m.has(11)) return { status, kind: 'pairing_request_ack' };
  if (m.has(20)) return { status, kind: 'options' };
  if (m.has(31)) return { status, kind: 'configuration_ack' };
  if (m.has(41)) return { status, kind: 'secret_ack' };
  return { status, kind: 'other' };
}

// ---------- Remote commands ----------

export const Feature = {
  PING: 1,
  KEY: 2,
  IME: 4,
  VOICE: 8,
  POWER: 32,
  VOLUME: 64,
  APP_LINK: 512,
} as const;

/** What this app asks the TV for. IME is what lets us type into text fields. */
export const OUR_FEATURES =
  Feature.PING | Feature.KEY | Feature.IME | Feature.POWER | Feature.VOLUME | Feature.APP_LINK;

export const KeyCode = {
  HOME: 3,
  BACK: 4,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  ENTER: 66,
  DEL: 67,
  SEARCH: 84,
} as const;

export const Direction = { START_LONG: 1, END_LONG: 2, SHORT: 3 } as const;

function remoteMessage(field: number, body: PbWriter): Uint8Array {
  return new PbWriter().message(field, body).finish();
}

export const remote = {
  configure: (features: number) =>
    remoteMessage(
      1,
      new PbWriter().uint(1, features).message(
        2,
        new PbWriter()
          .string(1, 'Teclado TV')
          .string(2, 'tele-teclado')
          .uint(3, 1)
          .string(4, '1')
          .string(5, 'atvremote')
          .string(6, '1.0.0'),
      ),
    ),
  setActive: (features: number) => remoteMessage(2, new PbWriter().uint(1, features)),
  pingResponse: (val1: number) => remoteMessage(9, new PbWriter().uint(1, val1 || undefined)),
  key: (keyCode: number, direction: number = Direction.SHORT) =>
    remoteMessage(10, new PbWriter().uint(1, keyCode).uint(2, direction)),
  /** Types `text` into the focused field on the TV (inserted at the cursor). */
  imeText: (text: string, imeCounter: number, fieldCounter: number) => {
    const cursor = Array.from(text).length - 1;
    const status = new PbWriter()
      .uint(1, cursor || undefined)
      .uint(2, cursor || undefined)
      .string(3, text);
    const edit = new PbWriter().uint(1, 1).message(2, status);
    return remoteMessage(
      21,
      new PbWriter()
        .uint(1, imeCounter || undefined)
        .uint(2, fieldCounter || undefined)
        .message(3, edit),
    );
  },
  appLink: (link: string) => remoteMessage(90, new PbWriter().string(1, link)),
};

export type TextFieldStatus = {
  counter: number;
  value: string;
  start: number;
  end: number;
  label: string;
};

export type RemoteIn =
  | { kind: 'configure'; features: number; model: string; vendor: string }
  | { kind: 'set_active' }
  | { kind: 'ping'; val1: number }
  | { kind: 'ime_key_inject'; appPackage: string; field: TextFieldStatus | null }
  | { kind: 'ime_batch_edit'; imeCounter: number; fieldCounter: number }
  | { kind: 'ime_show_request'; field: TextFieldStatus | null }
  | { kind: 'start'; started: boolean }
  | { kind: 'error' }
  | { kind: 'other'; fields: number[]; hex: string };

function textField(m: PbMessage): TextFieldStatus {
  return { counter: m.num(1), value: m.str(2), start: m.num(3), end: m.num(4), label: m.str(6) };
}

export function parseRemote(buf: Uint8Array): RemoteIn {
  const m = new PbMessage(buf);
  if (m.has(1)) {
    const cfg = m.msg(1);
    const info = cfg.msg(2);
    return { kind: 'configure', features: cfg.num(1), model: info.str(1), vendor: info.str(2) };
  }
  if (m.has(2)) return { kind: 'set_active' };
  if (m.has(3)) return { kind: 'error' };
  if (m.has(8)) return { kind: 'ping', val1: m.msg(8).num(1) };
  if (m.has(20)) {
    const inject = m.msg(20);
    return {
      kind: 'ime_key_inject',
      appPackage: inject.msg(1).str(12),
      field: inject.has(2) ? textField(inject.msg(2)) : null,
    };
  }
  if (m.has(21)) {
    const edit = m.msg(21);
    return { kind: 'ime_batch_edit', imeCounter: edit.num(1), fieldCounter: edit.num(2) };
  }
  if (m.has(22)) {
    const show = m.msg(22);
    return { kind: 'ime_show_request', field: show.has(2) ? textField(show.msg(2)) : null };
  }
  if (m.has(40)) return { kind: 'start', started: m.msg(40).num(1) === 1 };
  return { kind: 'other', fields: m.fieldNumbers(), hex: bytesToHex(buf) };
}
