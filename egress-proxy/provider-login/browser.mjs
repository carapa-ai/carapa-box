// The native CLI may invoke BROWSER. Never open a server-side browser or log
// the authorization URL. Only the login worker can read this private file.
import fs from 'node:fs';
// The worker sets HOME to the profile directory, which is /profile in the container.
const file = `${process.env.HOME || '/profile'}/browser-url.json`;
const url = process.argv.at(-1);
if (url?.startsWith('https://')) {
  // The worker polls this file every 250 ms. Rename keeps it from ever reading a
  // truncated, half-written file, which would fail a valid login.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(url), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
