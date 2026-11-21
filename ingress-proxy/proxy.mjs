// Protocol-transparent ingress: existing nginx terminates HTTP/TLS; sandbox sshd
// terminates SSH. No Docker access, HTTP parser, credentials, or destination API.
import net from 'node:net';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';

export function ipv4(value) {
  if (net.isIP(value) !== 4) throw new Error('Expected IPv4 address');
  return value.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}

export function cidr(value) {
  const [address, bits, ...extra] = value.split('/');
  const prefix = bits === undefined ? 32 : Number(bits);
  if (extra.length || (bits !== undefined && !/^\d+$/.test(bits)) || prefix < 0 || prefix > 32) throw new Error('Invalid IPv4 CIDR');
  const size = 2 ** (32 - prefix);
  const first = Math.floor(ipv4(address) / size) * size;
  return [first, first + size - 1];
}

export function matches(address, ranges) {
  const n = ipv4(address);
  return ranges.some(([first, last]) => first <= n && n <= last);
}

export function validateSnapshot(value, firstPort, lastPort, now = Date.now()) {
  if (value?.version !== 1 || typeof value.revision !== 'string' ||
      !Number.isFinite(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + 60_000 ||
      !Array.isArray(value.routes) || !Array.isArray(value.denyCidrs)) throw new Error('Invalid or expired ingress snapshot');
  const deny = value.denyCidrs.map(cidr);
  const routes = new Map();
  for (const route of value.routes) {
    if (!Number.isInteger(route.listenPort) || route.listenPort < firstPort || route.listenPort > lastPort || routes.has(route.listenPort) ||
        !Number.isInteger(route.targetPort) || route.targetPort < 1 || route.targetPort > 65535 ||
        !['http', 'ssh'].includes(route.kind) || (route.kind === 'ssh' && route.targetPort !== 2222) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(route.container) || !/^[a-f0-9]{64}$/.test(route.containerId) ||
        !Array.isArray(route.allowCidrs) || !route.allowCidrs.length) throw new Error('Invalid ingress route');
    ipv4(route.targetIp);
    ipv4(route.sourceIp);
    // A target must be on a protected backend subnet; neither loopback nor the
    // ingress edge is an acceptable upstream supplied through configuration.
    if (!matches(route.targetIp, deny) || !matches(route.sourceIp, deny) || route.targetIp === route.sourceIp) throw new Error('Unprotected ingress target');
    routes.set(route.listenPort, { ...route, allow: route.allowCidrs.map(cidr) });
  }
  return { ...value, routes, deny };
}

export function permitted(snapshot, route, remoteAddress, localAddress, bindAddress, now = Date.now()) {
  return snapshot && route && snapshot.expiresAt > now && localAddress === bindAddress &&
    net.isIP(remoteAddress) === 4 && !matches(remoteAddress, snapshot.deny) && matches(remoteAddress, route.allow);
}

export async function startProxy(options) {
  const { bindAddress, firstPort, lastPort, configPath, statusPath } = options;
  ipv4(bindAddress);
  if (!Number.isInteger(firstPort) || !Number.isInteger(lastPort) || firstPort < 1024 || lastPort > 65535 || lastPort < firstPort || lastPort - firstPort > 1023) throw new Error('Invalid ingress port range');
  let snapshot;
  let stopped = false;
  let updating = false;
  let lastError = '';
  let ready = false;
  const sessions = new Set();
  const servers = [];
  let nextDiagnostic = 0;
  const diagnose = (reason, client, port, detail = '') => {
    if (Date.now() < nextDiagnostic) return;
    nextDiagnostic = Date.now() + 5000;
    console.error('[ingress]', reason, { port, source: client.remoteAddress, local: client.localAddress, detail });
  };
  const routeIdentity = route => JSON.stringify([route?.containerId, route?.targetIp, route?.sourceIp, route?.targetPort, route?.kind, route?.allowCidrs]);
  const drop = session => { session.client.destroy(); session.upstream?.destroy(); sessions.delete(session); };
  const refresh = async () => {
    if (updating || stopped) return;
    updating = true;
    try {
      snapshot = validateSnapshot(JSON.parse(await fs.readFile(configPath, 'utf8')), firstPort, lastPort);
      lastError = '';
    } catch (error) {
      snapshot = undefined; // Missing, truncated, malformed, and expired all fail closed.
      if (lastError !== error.message) console.error('[ingress]', error.message);
      lastError = error.message;
    }
    for (const session of sessions) {
      const route = snapshot?.routes.get(session.port);
      if (routeIdentity(route) !== session.identity || !permitted(snapshot, route, session.client.remoteAddress, session.client.localAddress, bindAddress)) drop(session);
    }
    if (statusPath && ready) {
      // Readers (status checks, healthcheck) must never see a truncated file: write a sibling, then rename over it.
      const temporary = `${statusPath}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ revision: snapshot?.revision, expiresAt: snapshot?.expiresAt ?? 0, error: lastError }))
        .then(() => fs.rename(temporary, statusPath))
        .catch(error => console.error('[ingress] status:', error.message));
    }
    updating = false;
  };
  await refresh();
  try {
    for (let port = firstPort; port <= lastPort; port++) {
      const server = net.createServer({ pauseOnConnect: true, allowHalfOpen: true }, client => {
        client.on('error', () => {});
        const route = snapshot?.routes.get(port);
        if (sessions.size >= (options.maxConnections ?? 512) || !permitted(snapshot, route, client.remoteAddress, client.localAddress, bindAddress)) {
          diagnose('connection rejected', client, port, !snapshot ? 'no valid snapshot' : !route ? 'no route' : 'source/interface policy or connection limit');
          return client.destroy();
        }
        const session = { client, port, identity: routeIdentity(route), upstream: undefined };
        sessions.add(session);
        client.on('close', () => drop(session));
        client.setTimeout(3_600_000, () => drop(session));
        const deadline = setTimeout(() => drop(session), 5000);
        // Docker DNS is queried for each new connection. An expired container's
        // former IP must never route to a newly allocated, unrelated container.
        (async () => {
          const addresses = await (options.resolve ?? dns.resolve4)(route.container);
          if (client.destroyed || addresses.length !== 1 || addresses[0] !== route.targetIp ||
              routeIdentity(snapshot?.routes.get(port)) !== session.identity ||
              !permitted(snapshot, snapshot?.routes.get(port), client.remoteAddress, client.localAddress, bindAddress)) {
            diagnose('route validation failed', client, port, `DNS=${addresses.join(',')} expected=${route.targetIp}`);
            return drop(session);
          }
          const upstream = net.connect({ host: route.targetIp, port: route.targetPort, localAddress: route.sourceIp, allowHalfOpen: true });
          session.upstream = upstream;
          upstream.on('error', error => { diagnose('backend connection failed', client, port, error.code); drop(session); });
          upstream.on('close', hadError => {
            // A normal upstream FIN may arrive while a slow client still has
            // buffered response bytes. Flush those bytes before closing it.
            if (hadError) drop(session);
            else client.destroySoon();
          });
          upstream.on('connect', () => {
            clearTimeout(deadline);
            if (client.destroyed) return drop(session);
            client.pipe(upstream).pipe(client);
            client.resume();
          });
        })().catch(error => { diagnose('route lookup failed', client, port, error.code); drop(session); }).finally(() => { if (client.destroyed) clearTimeout(deadline); });
        client.on('close', () => clearTimeout(deadline));
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, bindAddress, () => { server.removeListener('error', reject); resolve(); });
      });
      servers.push(server);
      server.on('error', error => { console.error('[ingress] listener:', error.message); void close(); });
    }
  } catch (error) {
    for (const server of servers) server.close();
    throw error;
  }
  const timer = setInterval(refresh, options.pollMs ?? 500);
  ready = true;
  await refresh();
  async function close() {
    stopped = true;
    clearInterval(timer);
    for (const session of sessions) drop(session);
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  }
  return { close, refresh };
}
