import { describe, expect, it } from 'bun:test';
import { hostEnvValue, hostPath, hostPathsInText, hostUrlsInText, ipcRoot, relayBaseUrl } from './roots';

describe('runtime roots', () => {
  it('keeps the container layout by default', () => {
    expect(ipcRoot({})).toBe('/workspace/ipc');
    expect(hostPath('/workspace/group/a', {})).toBe('/workspace/group/a');
    expect(hostPathsInText('see /workspace/ipc/runs/r/x.png', {})).toBe('see /workspace/ipc/runs/r/x.png');
    expect(relayBaseUrl({})).toBe('http://api-relay:8080');
  });

  it('maps container paths onto native roots', () => {
    const env = { CARAPA_IPC_ROOT: '/r/ipc/p', CARAPA_GROUP_ROOT: '/r/groups/p', CARAPA_WORKSPACE_ROOT: '/r/ws', CARAPA_RELAY_URL: 'http://127.0.0.1:9/' };
    expect(hostPath('/workspace/ipc/runs/r1', env)).toBe('/r/ipc/p/runs/r1');
    expect(hostPath('/workspace/group', env)).toBe('/r/groups/p');
    expect(hostPath('/workspace/repo/src', env)).toBe('/r/ws/repo/src');
    expect(hostPath('/workspaces/x', env)).toBe('/workspaces/x');
    expect(hostPathsInText('- a.png: /workspace/ipc/runs/r1/a.png\nok', env)).toBe('- a.png: /r/ipc/p/runs/r1/a.png\nok');
    expect(relayBaseUrl(env)).toBe('http://127.0.0.1:9');
  });

  it('rewrites only standalone /workspace roots in prompt text', () => {
    const env = { CARAPA_WORKSPACE_ROOT: '/Users/me/ws' };
    for (const text of ['https://host/group/workspace/foo', '/home/u/workspace/x', '/workspaces/x', 'see /workspaces', 'a/workspace/x', '~/workspace/x']) {
      expect(hostPathsInText(text, env)).toBe(text);
    }
    expect(hostPathsInText('cd /workspace/repo, then `/workspace` and (/workspace/a/b). Root: /workspace.', env))
      .toBe('cd /Users/me/ws/repo, then `/Users/me/ws` and (/Users/me/ws/a/b). Root: /Users/me/ws.');
    expect(hostPathsInText('/workspace', env)).toBe('/Users/me/ws');
  });

  it('maps Board environment values for a native runner only', () => {
    const cdp = 'ws://api-relay:8080/board-api/api/web-browser/sessions/s/cdp';
    expect(hostEnvValue(cdp, {})).toBe(cdp);
    expect(hostEnvValue('/tmp/pwcli-s/sockets', {})).toBe('/tmp/pwcli-s/sockets');
    const env = { CARAPA_IPC_ROOT: '/r/ipc/p', CARAPA_RELAY_URL: 'http://127.0.0.1:9/s/p', CARAPA_TMP_ROOT: '/tmp/cb-1/' };
    expect(hostEnvValue(cdp, env)).toBe('ws://127.0.0.1:9/s/p/board-api/api/web-browser/sessions/s/cdp');
    expect(hostEnvValue('http://api-relay:8080/anthropic', env)).toBe('http://127.0.0.1:9/s/p/anthropic');
    expect(hostEnvValue('http://api-relay:80800/x', env)).toBe('http://api-relay:80800/x');
    expect(hostEnvValue('/tmp/pwcli-s/sockets', env)).toBe('/tmp/cb-1/pwcli-s/sockets');
    expect(hostEnvValue('/workspace/ipc/runs/r', env)).toBe('/r/ipc/p/runs/r');
    expect(hostEnvValue('/tmp/tools/bin', env)).toBe('/tmp/tools/bin');
    expect(hostEnvValue('http://llama-proxy:8881/v1', env)).toBe('http://127.0.0.1:9/s/p/llama-proxy/8881/v1');
    expect(hostEnvValue('http://llama-proxy:8881/v1', {})).toBe('http://llama-proxy:8881/v1');
    const toml = 'base_url = "http://llama-proxy:11434/v1"\nrelay = "http://api-relay:8080/codex"';
    expect(hostUrlsInText(toml, env)).toBe('base_url = "http://127.0.0.1:9/s/p/llama-proxy/11434/v1"\nrelay = "http://127.0.0.1:9/s/p/codex"');
    expect(hostUrlsInText(toml, {})).toBe(toml);
  });
});
