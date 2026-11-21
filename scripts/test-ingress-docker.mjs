// Isolated integration fixtures only. Never attach the test proxy to live networks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const image = process.env.INGRESS_TEST_IMAGE || 'carapa-box-ingress:dev';
const prefix = `carapa-ingress-test-${randomUUID().slice(0, 8)}`;
const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
const containers = [];
const networks = [];
const volume = `${prefix}-config`;
const docker = (...args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(`docker ${args[0]}: ${result.stderr || result.error}`);
  return result.stdout.trim();
};
const inspect = name => JSON.parse(docker('inspect', name))[0];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(fn) {
  for (let i = 0; ; i++) { try { return await fn(); } catch (error) { if (i >= 30) throw error; await delay(200); } }
}
const run = (name, ...args) => { containers.push(name); return docker('run', '-d', '--name', name, ...args); };
let proxy;
try {
  docker('image', 'inspect', image);
  const edge = `${prefix}-edge`, backend = `${prefix}-backend`;
  for (const name of [edge, backend]) { networks.push(name); docker('network', 'create', ...(name === backend ? ['--internal'] : []), name); }
  const edgeInfo = JSON.parse(docker('network', 'inspect', edge))[0].IPAM.Config[0];
  const backendInfo = JSON.parse(docker('network', 'inspect', backend))[0].IPAM.Config[0];
  const edgeIp = edgeInfo.Gateway.replace(/\d+$/, n => String(Number(n) + 1));
  docker('volume', 'create', volume);
  const writer = `${prefix}-writer`;
  run(writer, '--network', 'none', '-v', `${volume}:/config`, 'alpine:latest', 'sleep', '300');
  const workload = `${prefix}-sandbox`;
  run(workload, '--network', backend, '--cap-drop', 'ALL', '--read-only', '--entrypoint', 'node', image, '-e',
    "require('http').createServer((q,s)=>{s.setHeader('x-host',q.headers.host);s.end('sandbox-http')}).listen(8080);require('net').createServer(s=>{s.write('SSH-2.0-ingress-fixture\\r\\n');s.on('data',b=>s.write(b))}).listen(2222)");
  proxy = `${prefix}-proxy`;
  run(proxy, '--network', edge, '--ip', edgeIp, '--cap-drop', 'ALL', '--read-only',
    '--security-opt', 'no-new-privileges:true', '--security-opt', `seccomp=${path.resolve('security/seccomp-proxy.json')}`,
    '--security-opt', 'apparmor=carapabox-proxy', '--sysctl', 'net.ipv4.ip_forward=0', '--sysctl', 'net.ipv6.conf.all.forwarding=0',
    '--sysctl', 'net.ipv6.conf.all.disable_ipv6=1', '--tmpfs', '/run:uid=65532,gid=65532',
    '-e', `INGRESS_EDGE_IP=${edgeIp}`, '-e', 'INGRESS_PORT_START=22000', '-e', 'INGRESS_PORT_END=22001',
    '-v', `${volume}:/app/config:ro`, '-p', '127.0.0.1::22000', '-p', '127.0.0.1::22001', image);
  docker('network', 'connect', backend, proxy);
  const target = inspect(workload);
  const sourceIp = inspect(proxy).NetworkSettings.Networks[backend].IPAddress;
  const makeRoute = (listenPort, targetPort, kind) => ({ listenPort, targetPort, kind, container: workload, containerId: target.Id,
    targetIp: target.NetworkSettings.Networks[backend].IPAddress, sourceIp, allowCidrs: ['0.0.0.0/0'] });
  let doc = { version: 1, revision: 'initial', expiresAt: Date.now() + 40_000, denyCidrs: [backendInfo.Subnet],
    routes: [makeRoute(22000, 8080, 'http'), makeRoute(22001, 2222, 'ssh')] };
  async function publish() {
    doc.revision = randomUUID();
    const file = path.join(root, 'routes.json');
    await fs.writeFile(file, JSON.stringify(doc));
    docker('cp', file, `${writer}:/config/routes.tmp`);
    docker('exec', writer, 'sh', '-c', 'chmod 644 /config/routes.tmp && mv /config/routes.tmp /config/routes.json');
    await eventually(() => {
      const status = JSON.parse(docker('exec', proxy, 'node', '-e', "process.stdout.write(require('fs').readFileSync('/run/ingress-status.json','utf8'))"));
      assert.equal(status.revision, doc.revision);
    });
  }
  await publish();
  const hostPort = internal => Number(docker('port', proxy, String(internal)).split(':').at(-1));
  const response = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: hostPort(22000), headers: { Host: 'sandbox.example.test' } }, response => {
      let body = ''; response.on('data', chunk => body += chunk);
      response.on('end', () => resolve({ body, headers: response.headers }));
    }).on('error', reject);
  });
  assert.equal(response.body, 'sandbox-http');
  assert.equal(response.headers['x-host'], 'sandbox.example.test');
  console.log('PASS: published HTTP reaches the internal workload and preserves Host');
  const ssh = net.connect({ host: '127.0.0.1', port: hostPort(22001) });
  ssh.on('error', () => {});
  const banner = await new Promise((resolve, reject) => { ssh.once('data', b => resolve(b.toString())); ssh.once('error', reject); });
  assert.match(banner, /^SSH-2.0-ingress-fixture/);
  console.log('PASS: SSH byte stream reaches sandbox:2222');
  for (const address of [sourceIp, edgeIp]) {
    docker('exec', workload, 'node', '-e', `const s=require('net').connect({host:${JSON.stringify(address)},port:22001});s.on('connect',()=>process.exit(1));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),1000);`);
  }
  assert.equal(inspect(proxy).HostConfig.Sysctls['net.ipv4.ip_forward'], '0');
  console.log('PASS: sandbox cannot enter ingress on backend or edge addresses; IP forwarding disabled');
  const disconnected = new Promise((resolve, reject) => { ssh.once('close', resolve); setTimeout(() => reject(new Error('SSH survived revocation')), 3000).unref(); });
  doc.routes = doc.routes.filter(r => r.kind !== 'ssh'); await publish(); await disconnected;
  console.log('PASS: disabling SSH closes an established session');
  docker('restart', proxy);
  await eventually(async () => assert.equal(await (await fetch(`http://127.0.0.1:${hostPort(22000)}`)).text(), 'sandbox-http'));
  console.log('PASS: proxy restart restores routes on existing internal attachments');
  doc.expiresAt = Date.now() + 1800; await publish(); await delay(2000);
  await assert.rejects(fetch(`http://127.0.0.1:${hostPort(22000)}`, { signal: AbortSignal.timeout(2000) }));
  console.log('PASS: controller lease expiry fails closed');
} catch (error) {
  if (proxy) console.error(spawnSync('docker', ['logs', '--tail', '30', proxy], { encoding: 'utf8' }).stderr);
  throw error;
} finally {
  for (const name of containers.reverse()) spawnSync('docker', ['rm', '-fv', name], { stdio: 'ignore' });
  for (const name of networks.reverse()) spawnSync('docker', ['network', 'rm', name], { stdio: 'ignore' });
  spawnSync('docker', ['volume', 'rm', volume], { stdio: 'ignore' });
  await fs.rm(root, { recursive: true, force: true });
}
