// Exercises the real Compose serializer without creating Docker resources.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareIngressCompose, ingressComposePath } from '../src/compose/ingress.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ingress-compose-check-'));
const originalCwd = process.cwd();
try {
    process.chdir(root);
    Object.assign(process.env, { INGRESS_STATE_HOST_DIR: path.join(root, 'state'), INGRESS_STATE_DIR: path.join(root, 'state'), INGRESS_PUBLIC_HOST: '192.168.1.10', INGRESS_HTTP_ALLOW_CIDRS: '172.18.0.7/32', INGRESS_SSH_ALLOW_CIDRS: '192.168.1.0/24' });
    const project = 'ingress-check';
    await fs.writeFile(path.join(root, 'fixture.env'), "FROM_FILE='literal$from_file'\n");
    const source = { name: project, services: { nginx: {
        image: 'nginx:alpine', ports: [{ target: 80, published: '8080', protocol: 'tcp' }],
        environment: { LITERAL: 'abc$$literal$${untouched}' }, env_file: ['./fixture.env'],
        command: ['sh', '-c', 'printf "%s" "$$FROM_FILE"'],
        networks: { agent_egress: null, portonly: null },
    } }, networks: { agent_egress: { external: true, name: `agent_egress_${project}` }, portonly: { driver: 'bridge' } } };
    const file = path.join(root, 'compose.json');
    await fs.writeFile(file, JSON.stringify(source));
    const resolve = (filename: string) => {
        const result = spawnSync('docker', ['compose', '--project-directory', root, '-f', filename, 'config', '--format', 'json'], { encoding: 'utf8' });
        if (result.status !== 0) throw new Error(result.stderr);
        return JSON.parse(result.stdout);
    };
    const before = resolve(file);
    await prepareIngressCompose(before, project);
    const after = resolve(ingressComposePath(project));
    assert.deepEqual(after.services.nginx.environment, before.services.nginx.environment);
    assert.deepEqual(after.services.nginx.command, before.services.nginx.command);
    assert.equal(after.services.nginx.ports, undefined);
    assert.equal(after.networks.portonly, undefined);
    assert.deepEqual(after.services.nginx.networks, { agent_egress: null });
    assert.equal((await fs.stat(ingressComposePath(project))).mode & 0o777, 0o600);
    console.log('PASS: real Compose migration preserves literal dollars, env files, commands, and private file permissions; removes publications and portonly');
} finally {
    process.chdir(originalCwd);
    await fs.rm(root, { recursive: true, force: true });
}
