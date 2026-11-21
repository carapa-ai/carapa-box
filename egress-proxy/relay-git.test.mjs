import { expect, test } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { startApiRelay } from './api-relay/api-relay.mjs';

const TOKEN = 'glpat-test-token';
const BASIC = `Basic ${Buffer.from(`oauth2:${TOKEN}`).toString('base64')}`;
const gitlab = { auth: 'apikey', envKey: 'GITLAB_PAT', host: 'gl.test' };
const GITHUB_TOKEN = 'ghp-test-token';
// As a managed GitHub account installs it: API host for /github, the server for git.
const github = { auth: 'apikey', envKey: 'GITHUB_PAT', host: 'api.github.test', pathPrefix: '', gitHost: 'github.test', gitRepos: ['org/*'] };

async function startGitRelay(root) {
  fs.writeFileSync(path.join(root, 'default.json'), JSON.stringify({ providers: { gitlab }, services: {} }));
  fs.writeFileSync(path.join(root, 'cli.json'), JSON.stringify({ providers: { gitlab: { ...gitlab, gitRepos: ['group/*', 'group2/repo'] }, github } }));
  const calls = [];
  const state = { client: 'cli-1' };
  const relay = startApiRelay({
    port: 0, host: '127.0.0.1', clientsDir: root, hostnameResolver: () => state.client,
    env: { HTTP_PROXY: 'http://127.0.0.1:1', GITLAB_PAT: TOKEN, GITHUB_PAT: GITHUB_TOKEN, SNI_BRIDGE_PORT: '0' },
    externalRequest: async (provider, targetPath, method, headers, body) => {
      let received = 0;
      if (body) for await (const chunk of body) received += chunk.length;
      calls.push({ host: provider.host, targetPath, method, headers: { ...headers }, received });
      const upstream = Readable.from([Buffer.from('pack')]);
      upstream.statusCode = 200;
      upstream.headers = { 'content-type': 'application/x-git-upload-pack-result', 'set-cookie': 'session=1' };
      return upstream;
    },
  });
  if (!relay.server.listening) await once(relay.server, 'listening');
  return { relay, calls, state, port: relay.server.address().port };
}

function send(port, method, requestPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: requestPath, method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    request.once('error', reject);
    if (body) Readable.from(body).pipe(request); else request.end();
  });
}

test('git route serves upload-pack with Basic auth only, from the client allowlist, and streams large bodies', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-relay-git-test-'));
  let started;
  try {
    started = await startGitRelay(root);
    const { calls, state, port, relay } = started;
    const clientAuth = { authorization: 'Bearer client-secret', 'private-token': 'client-pat', cookie: 'sid=1', 'user-agent': 'git/2.45', 'git-protocol': 'version=2' };

    const refs = await send(port, 'GET', '/gitlab-git/group/repo.git/info/refs?service=git-upload-pack', { headers: clientAuth });
    expect(refs).toMatchObject({ status: 200, body: 'pack' });
    expect(refs.headers['set-cookie']).toBeUndefined();
    expect(calls[0]).toMatchObject({ host: 'gl.test', method: 'GET', targetPath: '/group/repo.git/info/refs?service=git-upload-pack' });
    expect(calls[0].headers).toMatchObject({ authorization: BASIC, host: 'gl.test', 'user-agent': 'git/2.45', 'git-protocol': 'version=2' });
    expect(Object.keys(calls[0].headers).filter(key => ['private-token', 'cookie'].includes(key))).toEqual([]);

    // 8 MiB request body arrives complete at the upstream.
    const big = Array.from({ length: 128 }, () => Buffer.alloc(64 * 1024, 1));
    const pack = await send(port, 'POST', '/gitlab-git/group2/repo.git/git-upload-pack', { headers: { ...clientAuth, 'content-type': 'application/x-git-upload-pack-request' }, body: big });
    expect(pack).toMatchObject({ status: 200, body: 'pack' });
    expect(calls[1]).toMatchObject({ method: 'POST', targetPath: '/group2/repo.git/git-upload-pack', received: 8 * 1024 * 1024 });
    expect(calls[1].headers.authorization).toBe(BASIC);
    expect(calls[1].headers.cookie).toBeUndefined();

    const denied = [
      ['GET', '/gitlab-git/group/repo.git/info/refs?service=git-receive-pack'],
      ['GET', '/gitlab-git/group/repo.git/info/refs?service=git-upload-pack&service=git-receive-pack'],
      ['GET', '/gitlab-git/group/repo.git/info/refs'],
      ['POST', '/gitlab-git/group/repo.git/git-receive-pack'],
      ['GET', '/gitlab-git/group/repo.git/git-upload-pack'],
      ['POST', '/gitlab-git/group/repo.git/info/lfs/objects/batch'],
      ['GET', '/gitlab-git/group/repo/-/archive/main.zip'],
      ['GET', '/gitlab-git/group/re%70o.git/info/refs?service=git-upload-pack'],
      ['GET', '/gitlab-git/group2/other.git/info/refs?service=git-upload-pack'],
      ['GET', '/gitlab-git/group/sub/repo.git/info/refs?service=git-upload-pack'],
      ['GET', '/gitlab-git/other/repo.git/info/refs?service=git-upload-pack'],
    ];
    for (const [method, requestPath] of denied) expect([method, requestPath, (await send(port, method, requestPath)).status]).toEqual([method, requestPath, 403]);

    state.client = 'other-1'; // matches no client: default.json has no gitRepos
    expect((await send(port, 'GET', '/gitlab-git/group/repo.git/info/refs?service=git-upload-pack')).status).toBe(403);
    expect(calls.length).toBe(2);
    relay.server.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('GitHub git route sends the GitHub token to the git server, never the API host', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-relay-git-test-'));
  try {
    const { calls, port, relay } = await startGitRelay(root);
    const refs = await send(port, 'GET', '/github-git/org/repo.git/info/refs?service=git-upload-pack', { headers: { authorization: 'Bearer client-secret' } });
    expect(refs).toMatchObject({ status: 200, body: 'pack' });
    expect(calls[0]).toMatchObject({ host: 'github.test', targetPath: '/org/repo.git/info/refs?service=git-upload-pack' });
    expect(calls[0].headers.authorization).toBe(`Basic ${Buffer.from(`x-access-token:${GITHUB_TOKEN}`).toString('base64')}`);
    // GitHub's allowlist is its own: GitLab's repos are not cloneable through it.
    expect((await send(port, 'GET', '/github-git/group/repo.git/info/refs?service=git-upload-pack')).status).toBe(403);
    expect((await send(port, 'POST', '/github-git/org/repo.git/git-receive-pack')).status).toBe(403);
    expect(calls.length).toBe(1);
    relay.server.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
