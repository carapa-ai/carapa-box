'use strict';
// Unix-socket transport for the viewer's dashboard. The pinned Playwright dashboard
// (`playwright-cli show`) listens on TCP; the native runner's agent sandbox allows
// neither local binding nor loopback TCP, only Unix sockets under the project's tmp
// root. When CARAPA_BROWSER_VIEWER_SOCKET names such a path, the dashboard listens
// there instead, and the viewer connects over the same socket. Containers leave the
// variable unset and keep the loopback TCP listener.
const http = require('node:http');

const MARKER = 'await httpServer.start({ port: options.port, host: options.host });';
// A string port is a pipe path for net.Server#listen; the empty host overrides the "localhost" default.
const REPLACEMENT = "await httpServer.start({ port: process.env.CARAPA_BROWSER_VIEWER_SOCKET, host: '' });";

/** Rewrite the dashboard's listen call in the pinned coreBundle.js; refuses a bundle that does not contain it. */
function patchDashboardSocket(source, env = process.env) {
  if (!env.CARAPA_BROWSER_VIEWER_SOCKET) return source;
  if (source.split(MARKER).length !== 2) throw new Error('Unsupported Playwright dashboard server implementation');
  return source.replace(MARKER, () => REPLACEMENT);
}

/** The dashboard socket this viewer uses, or undefined for the loopback TCP listener (CARAPA_BROWSER_VIEWER_TRANSPORT=unix selects the socket). */
function dashboardSocketPath(dir, env = process.env) {
  return env.CARAPA_BROWSER_VIEWER_TRANSPORT === 'unix' ? `${dir}/dashboard.sock` : undefined;
}

/** True once the dashboard announced `Listening on <socketPath>` (its URL is the socket path). */
function listeningOnSocket(startup, socketPath) {
  return startup.split('\n').some(line => line.trim() === `Listening on ${socketPath}`);
}

/**
 * Connect to the dashboard's websocket over its Unix socket: the dashboard redirects `/` to its
 * random path prefix (inspected, never followed) and serves the websocket at `<prefix>/ws`. The `ws` client of the pinned
 * Playwright package speaks `ws+unix://`; the platform WebSocket cannot.
 */
async function connectSocket(socketPath, requireCli) {
  const location = await new Promise((resolve, reject) => {
    const request = http.get({ socketPath, path: '/', timeout: 5000 }, response => {
      response.resume();
      resolve(response.headers.location || '');
    });
    request.on('timeout', () => request.destroy(new Error('Viewer dashboard timed out')));
    request.on('error', reject);
  });
  const target = new URL(location, 'http://dashboard.invalid/');
  const prefix = target.pathname.match(/^\/([A-Za-z0-9-]+)\/$/)?.[1];
  if (target.origin !== 'http://dashboard.invalid' || !prefix) throw new Error('Invalid viewer websocket');
  const WebSocketClient = requireCli('playwright-core/lib/utilsBundle').ws;
  return new WebSocketClient(`ws+unix://${socketPath}:/${prefix}/ws`);
}

module.exports = { patchDashboardSocket, dashboardSocketPath, listeningOnSocket, connectSocket };
