// Dev-only: lets the Android emulator reach the TV. macOS blocks the emulator from the
// home network, so this forwards 127.0.0.1:6466/6467 on the Mac to the TV. In the app's
// settings, set the TV address to 10.0.2.2 (the Mac, as seen from the emulator).
// TLS goes through untouched: this only copies bytes.

import net from 'node:net';

const tvHost = process.env.TV_HOST ?? '192.168.68.50';

for (const port of [6466, 6467]) {
  net
    .createServer((client) => {
      const upstream = net.connect(port, tvHost);
      client.pipe(upstream).pipe(client);
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on('error', close);
      upstream.on('error', close);
      console.log(`${new Date().toISOString()} ${port}: new connection`);
    })
    .listen(port, '127.0.0.1', () => console.log(`forwarding 127.0.0.1:${port} -> ${tvHost}:${port}`));
}
