// Explicit integration suite: never uses the host Docker socket inside a controller.
// Every controller has its own nested daemon, stack tree, secrets, and Compose namespace.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = await fs.mkdtemp('/tmp/carapa-plugin-docker-');
await fs.chmod(root, 0o755);
const prefix = path.basename(root).toLowerCase();
const containers = [], volumes = [], clients = [], units = [];
const uid = os.userInfo().uid, gid = os.userInfo().gid;
let helper;
const config = path.join(root, 'codex/config.toml');
const inventory = path.join(root, 'operator/hosts.json');
const dindImage = process.env.CARAPA_PLUGIN_DIND_IMAGE || 'docker:29.4.3-dind';
const controllerImage = process.env.CARAPA_PLUGIN_CONTROLLER_IMAGE || 'carapa-box:latest';
const sshImage = `${prefix}-sshd`;
let builtSsh = false;

function command(exe, args, options = {}) {
  const result = spawnSync(exe, args, { cwd: root, env: { ...process.env }, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${exe} ${args[0]} failed: ${(result.stderr || result.stdout || result.error || '').toString().slice(-1800)}`);
  return result.stdout;
}
const docker = (...args) => command('docker', args);
const cli = (...args) => command(helper, ['--config', config, '--inventory', inventory, ...args]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(fn, seconds = 40) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    try { return await fn(); }
    catch (error) { if (Date.now() > deadline) throw error; await sleep(300); }
  }
}
async function write(file, content, mode = 0o644) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
  await fs.writeFile(file, content, { mode });
}
function port(container, internal) {
  return Number(docker('port', container, `${internal}/tcp`).trim().split(':').at(-1));
}
async function connect(url, token, notifications) {
  const client = new Client({ name: 'carapa-box-plugin-integration', version: '0.1.0' });
  clients.push(client);
  client.setNotificationHandler(LoggingMessageNotificationSchema, notification => notifications.push(notification.params.data));
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  return result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
}

async function cleanup() {
  for (const client of clients) await client.close().catch(() => {});
  for (const name of units) {
    spawnSync('systemctl', ['--user', 'disable', '--now', name], { stdio: 'ignore' });
    spawnSync('systemctl', ['--user', 'reset-failed', name], { stdio: 'ignore' });
  }
  for (const name of [...containers].reverse()) spawnSync('docker', ['rm', '-fv', name], { stdio: 'ignore' });
  for (const name of volumes) spawnSync('docker', ['volume', 'rm', name], { stdio: 'ignore' });
  if (builtSsh) spawnSync('docker', ['image', 'rm', sshImage], { stdio: 'ignore' });
  await fs.rm(root, { recursive: true, force: true });
  if (units.length) spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => cleanup().finally(() => process.exit(1)));

try {
  console.log(`Isolated Docker integration resources: ${prefix}`);
  docker('image', 'inspect', controllerImage);
  docker('image', 'inspect', dindImage);
  docker('image', 'inspect', 'alpine:latest');
  command('python3', [path.join(repo, 'scripts/package-plugin.py'), '--output', path.join(root, 'installed plugin')]);
  command('python3', [path.join(root, 'installed plugin/scripts/install_helpers.py'), '--prefix', path.join(root, 'runtime')]);
  helper = path.join(root, 'runtime/bin/carapa-box-plugin');
  command(process.execPath, ['build', path.join(repo, 'src/index.ts'), '--target=node', '--outfile', path.join(root, 'index.js')], { cwd: repo });
  const opa = process.env.CARAPA_PLUGIN_OPA || path.join(repo, '.cache/opa/opa');
  const policy = path.join(root, 'policy.rego');
  await write(policy, 'package carapabox.stack.plugin_test\nimport rego.v1\ndefault result := {"allow": false, "reason": "fixture policy denied", "policy_name": "plugin_test.deny"}\nresult := {"allow": true, "reason": "fixture allowed", "policy_name": "plugin_test.allow"} if { input.service == "agent"; input.command == "/usr/local/stack-cli-bin/hello" }\n');
  command(opa, ['build', '-t', 'wasm', '-e', 'carapabox/stack/plugin_test/result', '-o', path.join(root, 'policy.tar.gz'), policy]);
  command('tar', ['xf', path.join(root, 'policy.tar.gz'), '-C', root, '/policy.wasm']);
  // Transfer a cached, tiny workload image into each test daemon without registry credentials.
  const alpineTar = path.join(root, 'alpine.tar');
  docker('save', '-o', alpineTar, 'alpine:latest');
  const hosts = [];
  for (const id of ['a', 'b']) {
    const fixture = path.join(root, id);
    const stack = path.join(fixture, 'stacks/shared');
    const token = randomBytes(32).toString('hex');
    await write(path.join(fixture, 'secrets/carapa_box_api_token'), token, 0o600);
    const adminFile = path.join(fixture, 'secrets/carapa_box_admin_token');
    await write(adminFile, randomBytes(32).toString('hex'), 0o600);
    await write(path.join(stack, 'docker-compose.yml'), `services:\n  agent:\n    image: alpine:latest\n    pull_policy: never\n    command: ["sh", "-c", "echo workload-${id}; exec sleep 600"]\n    read_only: true\n    cap_drop: [ALL]\n    security_opt: [no-new-privileges:true]\n    volumes:\n      - /fixtures/stacks/shared/bin:/usr/local/stack-cli-bin:ro\n`);
    await write(path.join(stack, 'bin/hello'), `#!/bin/sh\nprintf 'hello-${id}\\n'\nsleep 0.1\nprintf 'done-${id}\\n'\n`, 0o755);
    await write(path.join(stack, 'before-start.sh'), `#!/bin/sh\nprintf 'stream-start-${id}\\n'\n`, 0o755);
    await fs.copyFile(path.join(root, 'policy.wasm'), path.join(stack, 'policy.wasm'));
    await fs.cp(path.join(repo, 'config'), path.join(fixture, 'config'), { recursive: true });
    await fs.mkdir(path.join(fixture, 'generated'), { recursive: true });
    const socketVolume = `${prefix}-${id}-socket`;
    volumes.push(socketVolume);
    docker('volume', 'create', '--label', `carapa.plugin.test=${prefix}`, socketVolume);
    const daemon = `${prefix}-${id}-daemon`;
    containers.push(daemon);
    docker('run', '-d', '--name', daemon, '--label', `carapa.plugin.test=${prefix}`, '--privileged', '--network', 'none',
      '-v', `${socketVolume}:/docker-run`, '-v', `${fixture}:/fixtures`, '--entrypoint', 'dockerd', dindImage,
      '-H', 'unix:///docker-run/docker.sock', '--storage-driver', 'vfs', '--iptables=false', '--ip6tables=false');
    await eventually(() => docker('exec', daemon, 'docker', '-H', 'unix:///docker-run/docker.sock', 'info'));
    docker('exec', daemon, 'chown', `${uid}:${gid}`, '/docker-run/docker.sock');
    // Explicit byte pipe; no shell, host socket forwarding, or host environment injection.
    const imageBytes = await fs.readFile(alpineTar);
    command('docker', ['exec', '-i', daemon, 'docker', '-H', 'unix:///docker-run/docker.sock', 'load'], { input: imageBytes });
    const controller = `${prefix}-${id}-controller`;
    containers.push(controller);
    docker('run', '-d', '--name', controller, '--label', `carapa.plugin.test=${prefix}`, '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--security-opt', `seccomp=${path.join(repo, 'security/seccomp-default.json')}`,
      '--user', `${uid}:${gid}`, '--tmpfs', `/tmp:rw,uid=${uid},gid=${gid},mode=1777`,
      '-p', '127.0.0.1::3100', '-p', '127.0.0.1::22',
      '-v', `${socketVolume}:/docker-run`, '-v', `${fixture}:/fixtures:ro`,
      '-v', `${fixture}/config:/app/config:ro`, '-v', `${fixture}/generated:/app/generated`,
      '-v', `${root}/index.js:/app/dist/index.js:ro`,
      '-e', 'DOCKER_HOST=unix:///docker-run/docker.sock', '-e', 'SANDBOX_STACKS_DIR=/fixtures/stacks',
      '-e', 'SANDBOX_STACKS_HOST_DIR=/fixtures/stacks', '-e', 'SANDBOX_EGRESS_PROXY_DIR=/disabled-egress',
      '-e', 'SECRETS_DIR=/fixtures/secrets', '-e', 'AUDIT_LOG_PATH=/app/generated/audit.jsonl',
      ...(id === 'b' ? ['-e', 'ENABLE_SANDBOX_GIT=true'] : []), controllerImage);
    const url = `http://127.0.0.1:${port(controller, 3100)}`;
    const tokenFile = path.join(fixture, 'secrets/carapa_box_api_token');
    const name = `carapa_box_${id}`;
    cli('connection', name, '--url', url, '--token-file', tokenFile, '--admin-token-file', adminFile, '--mode', 'container');
    await eventually(() => cli('check', name));
    const notifications = [];
    // Read actual native config and execute its configured credential helper privately.
    const python = path.join(root, 'runtime/venv/bin/python');
    const header = JSON.parse(command(python, ['-c', 'import sys,tomlkit,subprocess; c=tomlkit.parse(open(sys.argv[1]).read()); print(subprocess.check_output(c["mcp_servers"][sys.argv[2]]["http_headers_helper"], shell=True, text=True),end="")', config, name]));
    assert.equal(header.Authorization, `Bearer ${token}`);
    const client = await connect(url, token, notifications);
    hosts.push({ id, daemon, controller, url, token, tokenFile, name, notifications, client });
  }
  const [a, b] = hosts;
  const catalogs = await Promise.all(hosts.map(host => host.client.listTools()));
  assert.ok(catalogs.every(catalog => catalog.tools.some(tool => tool.name === 'sandbox_start' && tool.inputSchema.properties.name)));
  assert.ok(!catalogs[0].tools.some(tool => tool.name === 'sandbox_git'));
  assert.ok(catalogs[1].tools.some(tool => tool.name === 'sandbox_git'));
  await Promise.all(hosts.map(async host => {
    assert.deepEqual(JSON.parse(await call(host.client, 'sandbox_list')).map(stack => stack.name), ['shared']);
    const wrong = await fetch(`${host.url}/api/tools`, { headers: { Authorization: `Bearer ${host.id === 'a' ? b.token : a.token}` } });
    assert.equal(wrong.status, 401);
    await call(host.client, 'sandbox_start', { name: 'shared', instance: 'same' });
    const output = await call(host.client, 'sandbox_exec', { name: 'shared', instance: 'same', service: 'agent', command: 'hello' });
    assert.ok(output.includes(`hello-${host.id}`) && output.includes(`done-${host.id}`));
    const denied = await host.client.callTool({ name: 'sandbox_exec', arguments: { name: 'shared', instance: 'same', service: 'agent', command: 'hello forbidden' } });
    assert.equal(denied.isError, true);
    const policyResult = JSON.parse(await call(host.client, 'sandbox_policy_check', { name: 'shared', service: 'agent', command: '/usr/local/stack-cli-bin/hello forbidden' }));
    assert.equal(policyResult.allowed, false);
    assert.ok((await call(host.client, 'sandbox_logs', { name: 'shared', instance: 'same', service: 'agent', tail: 10 })).includes(`workload-${host.id}`));
    await eventually(() => assert.ok(host.notifications.some(message => String(message).includes(`stream-start-${host.id}`))));
  }));
  console.log('PASS: two native MCP sessions; isolated stacks/credentials; different capabilities; execution, policy denial, logs, streaming.');
  await call(a.client, 'sandbox_stop', { name: 'shared', instance: 'same' });
  assert.ok((await call(b.client, 'sandbox_exec', { name: 'shared', instance: 'same', service: 'agent', command: 'hello' })).includes('hello-b'));
  docker('stop', a.controller);
  assert.ok((await call(b.client, 'sandbox_exec', { name: 'shared', instance: 'same', service: 'agent', command: 'hello' })).includes('hello-b'));
  docker('start', a.controller);
  // Docker may reassign an ephemeral published port when a container restarts.
  a.url = `http://127.0.0.1:${port(a.controller, 3100)}`;
  cli('connection', a.name, '--url', a.url, '--token-file', a.tokenFile, '--update');
  await eventually(() => cli('check', a.name));
  console.log('PASS: stopping a same-named sandbox/controller leaves the other host operational.');

  // Real SSH server sharing controller A's network namespace: localhost:3100 is the remote Box.
  const sshFixture = path.join(root, 'ssh');
  await fs.mkdir(sshFixture);
  command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(sshFixture, 'client')]);
  command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(sshFixture, 'host')]);
  await write(path.join(sshFixture, 'sshd_config'), 'Port 22\nListenAddress 0.0.0.0\nHostKey /fixture/host\nAuthorizedKeysFile /fixture/client.pub\nPermitRootLogin prohibit-password\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nStrictModes no\nAllowTcpForwarding local\nPermitOpen 127.0.0.1:3100\n');
  await write(path.join(sshFixture, 'Dockerfile'), 'FROM alpine:latest\nRUN apk add --no-cache openssh-server && passwd -d root\nCMD ["/usr/sbin/sshd", "-D", "-e", "-f", "/fixture/sshd_config"]\n');
  docker('build', '-t', sshImage, sshFixture);
  builtSsh = true;
  const sshContainer = `${prefix}-sshd`;
  containers.push(sshContainer);
  docker('run', '-d', '--name', sshContainer, '--label', `carapa.plugin.test=${prefix}`, '--network', `container:${a.controller}`, '-v', `${sshFixture}:/fixture:ro`, sshImage);
  const sshPort = port(a.controller, 22);
  await write(path.join(sshFixture, 'known_hosts'), `[127.0.0.1]:${sshPort} ${(await fs.readFile(path.join(sshFixture, 'host.pub'), 'utf8')).trim()}\n`, 0o600);
  const sshAlias = `box-test-${prefix}`;
  await write(path.join(sshFixture, 'config'), `Host ${sshAlias}\n  HostName 127.0.0.1\n  Port ${sshPort}\n  User root\n  IdentityFile ${sshFixture}/client\n  IdentitiesOnly yes\n  UserKnownHostsFile ${sshFixture}/known_hosts\n`, 0o600);
  // Scoped ssh executable shim supplies this fixture's -F config; generated unit still exercises
  // the real OpenSSH executable, host verification, forwarding, and systemd restart semantics.
  const testBin = path.join(root, 'bin');
  const realSsh = command('which', ['ssh']).trim();
  await write(path.join(testBin, 'ssh'), `#!/bin/sh\nexec ${realSsh} -F '${sshFixture}/config' "$@"\n`, 0o755);
  const net = await import('node:net');
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const tunnelPort = reservation.address().port;
  const tunnelName = `carapa_box_test_${prefix.replaceAll('-', '_').toLowerCase()}`;
  const tunnelUrl = `http://127.0.0.1:${tunnelPort}`;
  cli('connection', tunnelName, '--url', tunnelUrl, '--token-file', a.tokenFile, '--ssh-alias', sshAlias);
  const unitDir = path.join(root, 'units');
  assert.throws(() => cli('tunnel', tunnelName, 'install', '--unit-dir', unitDir), /failed/);
  await new Promise(resolve => reservation.close(resolve));
  const oldPath = process.env.PATH;
  process.env.PATH = `${testBin}:${oldPath}`;
  try { cli('tunnel', tunnelName, 'install', '--unit-dir', unitDir); }
  finally { process.env.PATH = oldPath; }
  const unitName = `carapa-box-tunnel-${tunnelName}.service`;
  assert.ok((await fs.readFile(path.join(unitDir, unitName), 'utf8')).includes(path.join(testBin, 'ssh')),
    'The test tunnel must use the fixture SSH config shim');
  units.push(unitName);
  // Unknown host key must not silently connect. Restore the pinned key before activation.
  const known = await fs.readFile(path.join(sshFixture, 'known_hosts'));
  await fs.writeFile(path.join(sshFixture, 'known_hosts'), '');
  const rejected = spawnSync(realSsh, ['-F', path.join(sshFixture, 'config'), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', sshAlias, 'true'], { encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  await fs.writeFile(path.join(sshFixture, 'known_hosts'), known);
  await eventually(() => command(realSsh, ['-F', path.join(sshFixture, 'config'), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', sshAlias, 'true']));
  cli('tunnel', tunnelName, 'start');
  const tunnelClient = await connect(tunnelUrl, a.token, []);
  assert.deepEqual(JSON.parse(await call(tunnelClient, 'sandbox_list')).map(stack => stack.name), ['shared']);
  await tunnelClient.close();
  docker('restart', sshContainer);
  await eventually(() => cli('tunnel', tunnelName, 'status'));
  const reconnected = await connect(tunnelUrl, a.token, []);
  assert.ok((await reconnected.listTools()).tools.some(tool => tool.name === 'sandbox_start'));
  const unrelated = path.join(unitDir, 'unrelated.service');
  await write(unrelated, '# operator-owned fixture\n');
  cli('tunnel', tunnelName, 'remove');
  assert.equal(await fs.readFile(unrelated, 'utf8'), '# operator-owned fixture\n');
  assert.ok((await b.client.listTools()).tools.some(tool => tool.name === 'sandbox_git'));
  console.log('PASS: real SSH known-host rejection, loopback forwarding, port conflict, systemd readiness/reconnect, and targeted removal.');
  await call(b.client, 'sandbox_stop', { name: 'shared', instance: 'same' });
  console.log('All Docker integration checks passed.');
} finally {
  await cleanup();
  console.log(`Cleaned up ${prefix} containers, volumes, services, and temporary files.`);
}
