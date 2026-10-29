// Test tool: talks to the TV from the Mac with the same protocol code the app uses.
//
//   npm run tv -- pair              asks the TV for a code, then reads it from stdin
//   npm run tv -- type "hola mundo" types it letter by letter, like the app does
//   npm run tv -- key ENTER         sends a key (HOME, BACK, ENTER, DEL, SEARCH, DPAD_*)
//   npm run tv -- link <url>        opens a link on the TV (e.g. https://www.youtube.com)
//   npm run tv -- listen 30         prints what the TV sends for 30 seconds
//
// TV address: env TV_HOST (default 192.168.68.50).

import readline from 'node:readline/promises';

import { KeyCode } from '../src/protocol/messages';
import { PairingSession } from '../src/protocol/pairing';
import { RemoteSession } from '../src/protocol/session';
import { diffText, needsAsciiOnly, textForTv } from '../src/protocol/textSync';
import { nodeTransport } from './nodeTransport';

const host = process.env.TV_HOST ?? '192.168.68.50';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function openSession(verbose = !!process.env.VERBOSE): Promise<RemoteSession> {
  let markReady!: () => void;
  let markFailed!: (e: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    markFailed = reject;
  });
  const timer = setTimeout(() => markFailed(new Error('timeout waiting for the TV')), 8000);
  const session = await RemoteSession.open(nodeTransport, host, {
    onReady: () => markReady(),
    onClose: (reason, detail) => {
      console.log(`session closed: ${reason}${detail ? ` (${detail})` : ''}`);
      markFailed(new Error(reason));
    },
    onApp: (app) => console.log(`app on TV: ${app}`),
    onTextField: (field) => console.log(`text field: ${JSON.stringify(field)}`),
    onDebug: (line) => verbose && console.log(line),
  });
  await ready;
  clearTimeout(timer);
  return session;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'pair': {
      const pairing = await PairingSession.start(nodeTransport, host, 'Teclado TV (Mac)');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      for (;;) {
        const code = await rl.question('Código que muestra la tele: ');
        try {
          await pairing.finish(code);
          console.log('Vinculado.');
          break;
        } catch (e) {
          console.log(`Error: ${(e as Error).message}`);
          if (pairing.isClosed) break;
        }
      }
      rl.close();
      break;
    }
    case 'del': {
      const session = await openSession();
      await sleep(Number(process.env.WAIT_MS ?? 300));
      for (let i = 0; i < Number(args[0] ?? 1); i++) {
        session.sendDeletes(1);
        await sleep(Number(process.env.DELAY_MS ?? 80));
      }
      await sleep(500);
      session.close();
      break;
    }
    case 'type': {
      const session = await openSession();
      await sleep(Number(process.env.WAIT_MS ?? 300));
      const text = args.join(' ');
      const asciiOnly = needsAsciiOnly(session.currentApp);
      let onTv = '';
      for (let i = 1; i <= Array.from(text).length; i++) {
        const target = textForTv(Array.from(text).slice(0, i).join(''), asciiOnly);
        const { deletes, insert } = diffText(onTv, target);
        session.sendDeletes(deletes);
        session.sendText(insert);
        onTv = target;
        await sleep(Number(process.env.DELAY_MS ?? 80));
      }
      await sleep(500);
      session.close();
      break;
    }
    case 'send': {
      const session = await openSession();
      session.sendText(args.join(' '));
      await sleep(800);
      session.close();
      break;
    }
    case 'key': {
      const name = (args[0] ?? '').toUpperCase() as keyof typeof KeyCode;
      const code = KeyCode[name] ?? Number(args[0]);
      if (!code) throw new Error(`unknown key ${args[0]}`);
      const session = await openSession();
      session.sendKey(code);
      await sleep(500);
      session.close();
      break;
    }
    case 'link': {
      const session = await openSession();
      session.openLink(args[0]);
      await sleep(800);
      session.close();
      break;
    }
    case 'steps': {
      // e.g. steps wait:1500 "text: perros" key:ENTER wait:5000
      const session = await openSession();
      for (const step of args) {
        const [kind, ...rest] = step.split(':');
        const value = rest.join(':');
        if (kind === 'wait') await sleep(Number(value));
        else if (kind === 'text') session.sendText(value);
        else if (kind === 'del') session.sendDeletes(Number(value));
        else if (kind === 'key') session.sendKey(KeyCode[value.toUpperCase() as keyof typeof KeyCode] ?? Number(value));
        else if (kind === 'link') session.openLink(value);
        console.log(`step ${step}`);
      }
      session.close();
      break;
    }
    case 'listen': {
      const session = await openSession();
      await sleep(Number(args[0] ?? 30) * 1000);
      session.close();
      break;
    }
    default:
      console.log('Usage: npm run tv -- pair | type <text> | send <text> | key <NAME> | link <url> | listen [seconds]');
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
