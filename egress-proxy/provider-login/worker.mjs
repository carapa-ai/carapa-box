import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export function authorization(provider, value) {
  if (typeof value !== 'string' || value.length > 16384) throw new Error('Invalid authorization URL');
  const url = new URL(value);
  const hosts = provider === 'antigravity' ? ['accounts.google.com']
    : provider === 'codex' ? ['auth.openai.com'] : provider === 'meta' ? ['auth.meta.com']
    : provider === 'xai' ? ['accounts.x.ai', 'auth.x.ai'] : provider === 'cursor' ? ['cursor.com']
    : ['claude.ai', 'claude.com', 'console.anthropic.com', 'platform.claude.com'];
  if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.username || url.password || url.hash || url.port) throw new Error('Invalid authorization origin');
  if (provider === 'codex') {
    if (url.pathname !== '/codex/device' || url.search) throw new Error('Invalid device login URL');
    return { url: url.href };
  }
  if (provider === 'meta') {
    // Muse's device page carries only the code the user confirms there.
    const code = url.searchParams.get('code');
    if (url.pathname !== '/oauth/device/' || [...url.searchParams.keys()].join() !== 'code' || !/^[A-Z0-9-]{4,30}$/.test(code)) {
      throw new Error('Invalid device login URL');
    }
    return { url: url.href, userCode: code };
  }
  if (provider === 'xai') {
    // Grok prints verification_uri_complete when xAI sends one, else the bare page.
    const code = url.searchParams.get('user_code');
    if (!url.pathname.startsWith('/oauth2/device') || [...url.searchParams.keys()].some(key => key !== 'user_code') ||
        (code !== null && !/^[A-Z0-9-]{4,30}$/.test(code))) throw new Error('Invalid device login URL');
    return { url: url.href, ...(code ? { userCode: code } : {}) };
  }
  if (provider === 'cursor') {
    // Cursor's browser login: the page confirms a PKCE challenge while the CLI
    // polls api2.cursor.sh. Nothing is returned to Board but this link.
    const allowed = { challenge: /^[A-Za-z0-9_-]{43}$/, uuid: /^[0-9a-f-]{36}$/, mode: /^login$/,
      redirectTarget: /^cli$/, supportsSelectedTeamLogin: /^true$/ };
    const keys = [...url.searchParams.keys()];
    if (url.pathname !== '/loginDeepControl' || keys.length !== new Set(keys).size || !url.searchParams.has('challenge') ||
        !url.searchParams.has('uuid') || keys.some(key => !allowed[key]?.test(url.searchParams.get(key)))) throw new Error('Invalid Cursor login URL');
    return { url: url.href };
  }
  if (provider === 'anthropic' && !['/oauth/authorize', '/cai/oauth/authorize'].includes(url.pathname)) throw new Error('Invalid Claude authorization path');
  if (provider === 'antigravity' && url.pathname !== '/o/oauth2/v2/auth') throw new Error('Invalid Google authorization path');
  const state = url.searchParams.get('state');
  if (!state || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('response_type') !== 'code') throw new Error('Invalid OAuth request');
  const redirect = new URL(url.searchParams.get('redirect_uri'));
  if (provider === 'antigravity' && (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' ||
      Number(redirect.port) < 1024 || redirect.pathname !== '/' || redirect.search || redirect.hash)) throw new Error('Invalid OAuth callback');
  return { url: url.href, state, redirect: redirect.href };
}

export function validateCallback(auth, value) {
  if (typeof value !== 'string' || value.length > 16384) throw new Error('Invalid callback');
  const callback = new URL(value);
  const expected = new URL(auth.redirect);
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.username || callback.password || callback.hash ||
      callback.searchParams.getAll('state').length !== 1 || callback.searchParams.get('state') !== auth.state ||
      callback.searchParams.getAll('code').length !== 1 || !callback.searchParams.get('code') || callback.searchParams.has('error')) throw new Error('Callback does not match this login');
  return callback;
}

function atomic(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export async function runLogin(provider, profile = '/profile') {
  if (!['codex', 'anthropic', 'antigravity', 'meta', 'xai', 'cursor'].includes(provider)) throw new Error('Unsupported provider');
  process.umask(0o077);
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin:/opt/carapa-harness/bin', HOME: profile,
    CODEX_HOME: path.join(profile, '.codex'), CLAUDE_CONFIG_DIR: path.join(profile, '.claude'), GEMINI_HOME: path.join(profile, '.gemini'),
    GROK_HOME: path.join(profile, '.grok'), GROK_DISABLE_AUTOUPDATER: '1', GROK_TELEMETRY_ENABLED: '0',
    BROWSER: 'node /helper/browser.mjs %s', PYTHONUNBUFFERED: '1', AGY_ACP_FORCE_FILE_STORAGE: '1',
    ANTIGRAVITY_HARNESS_PATH: process.env.ANTIGRAVITY_ACP_HARNESS || '/opt/carapa-harness/antigravity-acp/localharness_external',
    ...(process.env.CARAPA_HARNESS_SNAPSHOT ? { CARAPA_HARNESS_SNAPSHOT: process.env.CARAPA_HARNESS_SNAPSHOT } : {}),
    HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  fs.mkdirSync(env.CODEX_HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), 'cli_auth_credentials_store = "file"\n');
  let auth, finished = false, submitted = false, version = 'unknown';
  const report = value => atomic(path.join(profile, 'status.json'), value);
  report({ state: 'starting' });
  const command = provider === 'codex' ? ['codex', 'app-server'] : provider === 'anthropic' ? ['claude', 'auth', 'login', '--claudeai']
    : provider === 'meta' ? ['muse', 'login'] : provider === 'xai' ? ['grok', 'login', '--device-auth']
    : provider === 'cursor' ? ['cursor-agent', 'login'] : [process.env.ANTIGRAVITY_ACP_BIN || '/opt/carapa-harness/antigravity-acp/agy_acp_server.par', '--uid='];
  const child = spawn(command[0], command.slice(1), { cwd: profile, env, stdio: ['pipe', 'pipe', 'pipe'] });
  // Claude's login prompt can arrive without a newline. Scan a bounded rolling
  // buffer as well as complete lines so that waiting for user input does not
  // hide the authorization URL from the controller.
  let claudeOutput = '';
  if (provider === 'anthropic') {
    const scan = chunk => {
      claudeOutput = (claudeOutput + chunk.toString()).slice(-65536);
      for (const match of claudeOutput.matchAll(/https:\/\/[^\s<>"\x00-\x1f]+(?=[\s\x00-\x1f])/g)) showUrl(match[0]);
    };
    child.stdout.on('data', scan); child.stderr.on('data', scan);
  }
  const send = (id, method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  const finish = success => {
    if (finished) return;
    finished = true;
    clearInterval(poll); clearTimeout(deadline);
    try {
      if (success) {
        const file = provider === 'codex' ? path.join(env.CODEX_HOME, 'auth.json') : provider === 'anthropic' ? path.join(env.CLAUDE_CONFIG_DIR, '.credentials.json')
          : provider === 'meta' ? path.join(profile, '.config', 'muse', 'auth.json')
          : provider === 'xai' ? path.join(env.GROK_HOME, 'auth.json')
          : provider === 'cursor' ? path.join(profile, '.config', 'cursor', 'auth.json') : path.join(env.GEMINI_HOME, 'antigravity-acp', 'acp_token.json');
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (provider === 'antigravity') data.relayAcpVersion = version;
        atomic(path.join(profile, 'result.json'), data);
      }
      report({ state: success ? 'completed' : 'failed' });
    } catch { report({ state: 'failed' }); }
    child.kill('SIGTERM');
    setTimeout(() => { child.kill('SIGKILL'); process.exit(0); }, 500).unref();
  };
  const showUrl = value => {
    if (finished || submitted) return;
    try {
      const next = authorization(provider, value);
      if (auth && auth.url !== next.url) return;
      auth = next;
      report({ state: 'waiting', authorizationUrl: auth.url, ...(auth.userCode ? { userCode: auth.userCode } : {}),
        input: provider === 'antigravity' ? 'callback' : ['meta', 'xai', 'cursor'].includes(provider) ? 'none' : 'code' });
    } catch { /* Native diagnostics are deliberately not exposed. */ }
  };
  function line(text, stdout) {
    if (text.length > 65536) return finish(false);
    if (stdout && !['anthropic', 'meta', 'xai', 'cursor'].includes(provider)) {
      try {
        const message = JSON.parse(text);
        if (message.error) return finish(false);
        if (message.id === 1) {
          version = String(message.result?.agentInfo?.version || 'unknown').replace(/[^a-zA-Z0-9.-]/g, '-');
          if (provider === 'codex') {
            child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
            send(2, 'account/login/start', { type: 'chatgptDeviceCode' });
          } else send(2, 'authenticate', { methodId: 'oauth-personal' });
        }
        if (provider === 'codex' && message.id === 2) {
          const result = message.result;
          auth = authorization(provider, result.verificationUrl);
          if (!/^[A-Z0-9-]{4,30}$/.test(result.userCode)) return finish(false);
          report({ state: 'waiting', authorizationUrl: auth.url, userCode: result.userCode, input: 'none' });
        }
        if (provider === 'codex' && message.method === 'account/login/completed') finish(message.params?.success === true);
        if (provider === 'antigravity' && message.id === 2 && message.result) finish(true);
      } catch { /* Non-protocol native output is never sent to Board. */ }
    }
    if (provider !== 'codex') for (const match of text.matchAll(/https:\/\/[^\s<>"\x1b]+/g)) showUrl(match[0]);
    // Without a complete URL, Grok prints the code on its own line after the link.
    const code = provider === 'xai' && auth && !auth.userCode && /^\s*([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)\s*$/.exec(text)?.[1];
    if (code && !finished && !submitted) {
      auth = { ...auth, userCode: code };
      report({ state: 'waiting', authorizationUrl: auth.url, userCode: code, input: 'none' });
    }
  }
  createInterface({ input: child.stdout }).on('line', text => line(text, true));
  createInterface({ input: child.stderr }).on('line', text => line(text, false));
  child.on('error', () => finish(false));
  child.on('exit', code => { if (!finished) finish(['anthropic', 'meta', 'xai', 'cursor'].includes(provider) && code === 0); });
  // The controller writes the submitted code into this private, single-use
  // mailbox. It is never passed as a command argument or Docker log entry.
  const poll = setInterval(async () => {
    try {
      const browserFile = path.join(profile, 'browser-url.json');
      if (!auth && fs.existsSync(browserFile)) showUrl(JSON.parse(fs.readFileSync(browserFile, 'utf8')));
      const inputFile = path.join(profile, 'input.json');
      if (!auth || submitted || !fs.existsSync(inputFile)) return;
      const { value } = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
      fs.unlinkSync(inputFile);
      if (provider === 'antigravity') {
        const callback = validateCallback(auth, value);
        submitted = true;
        await new Promise((resolve, reject) => {
          const req = http.get(callback, { agent: false }, res => {
            res.resume(); res.on('end', () => res.statusCode === 200 ? resolve() : reject());
          });
          req.setTimeout(10000, () => req.destroy()); req.on('error', reject);
        });
      } else if (provider === 'anthropic' && typeof value === 'string' && /^[^\s]{1,4096}$/.test(value)) {
        submitted = true; child.stdin.write(value + '\n');
      } else throw new Error('Invalid login input');
      if (!finished) report({ state: 'authorizing' });
    } catch { finish(false); }
  }, 250);
  const deadline = setTimeout(() => finish(false), 15 * 60_000);
  if (!['anthropic', 'meta', 'xai', 'cursor'].includes(provider)) send(1, 'initialize', provider === 'codex'
    ? { clientInfo: { name: 'carapa-box-login', version: '1' } }
    : { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'carapa-box', version: '1' } });
}

if (process.argv[1] && path.basename(process.argv[1]) === 'worker.mjs' && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.CARAPA_HARNESS_SNAPSHOT && fs.existsSync('/opt/carapa-harness/bin/carapa-harness-exec')) {
    const child = spawnSync('/opt/carapa-harness/bin/carapa-harness-exec', [process.execPath, ...process.argv.slice(1)], { stdio: 'inherit' });
    process.exit(child.status ?? 1);
  }
  runLogin(process.argv[2]).catch(() => process.exit(1));
}
