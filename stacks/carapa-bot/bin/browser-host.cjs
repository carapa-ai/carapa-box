'use strict';
// Host paths for the browser scripts. Board writes container paths (descriptor,
// run dir, /tmp/pwcli-*, api-relay URLs). A native runner (Mac) has no container,
// so they are mapped with the same rules as runtime/roots.ts (hostPath,
// hostEnvValue, nativeRoots); CJS cannot import that module. Identity in
// containers, where the CARAPA_*_ROOT variables are unset.
const CONTAINER_IPC = '/workspace/ipc';
const CONTAINER_GROUP = '/workspace/group';
const CONTAINER_WORKSPACE = '/workspace';
const CONTAINER_RELAY = /^(https?|wss?):\/\/api-relay:8080(?=\/|$)/;
const CONTAINER_LLAMA = /^http:\/\/llama-proxy:(\d+)(?=\/|$)/;
const SESSION_NAME = /^pwcli-[A-Za-z0-9._-]+$/;

const nativeRoots = (env = process.env) => Boolean(env.CARAPA_IPC_ROOT || env.CARAPA_GROUP_ROOT || env.CARAPA_WORKSPACE_ROOT);
const relayBaseUrl = (env = process.env) => (env.CARAPA_RELAY_URL || 'http://api-relay:8080').replace(/\/+$/, '');
const tmpRoot = (env = process.env) => env.CARAPA_TMP_ROOT ? env.CARAPA_TMP_ROOT.replace(/\/+$/, '') : undefined;

function mapPrefix(value, prefix, target) {
  if (!target) return null;
  if (value === prefix) return target;
  if (value.startsWith(prefix + '/')) return target + value.slice(prefix.length);
  return null;
}

function hostPath(value, env = process.env) {
  if (!value.startsWith(CONTAINER_WORKSPACE)) return value;
  return mapPrefix(value, CONTAINER_IPC, env.CARAPA_IPC_ROOT)
    ?? mapPrefix(value, CONTAINER_GROUP, env.CARAPA_GROUP_ROOT)
    ?? mapPrefix(value, CONTAINER_WORKSPACE, env.CARAPA_WORKSPACE_ROOT)
    ?? value;
}

function hostEnvValue(value, env = process.env) {
  if (!nativeRoots(env)) return value;
  const relay = CONTAINER_RELAY.exec(value);
  if (relay && env.CARAPA_RELAY_URL) {
    const base = relayBaseUrl(env);
    return (relay[1].startsWith('ws') ? base.replace(/^http/, 'ws') : base) + value.slice(relay[0].length);
  }
  const llama = CONTAINER_LLAMA.exec(value);
  if (llama && env.CARAPA_RELAY_URL) return `${relayBaseUrl(env)}/llama-proxy/${llama[1]}${value.slice(llama[0].length)}`;
  const tmp = tmpRoot(env);
  if (tmp && value.startsWith('/tmp/pwcli-')) return `${tmp}/${value.slice('/tmp/'.length)}`;
  return hostPath(value, env);
}

/** Map every string value of an environment object Board wrote for a container. */
function hostEnv(values, env = process.env) {
  return Object.fromEntries(Object.entries(values || {}).map(([key, value]) => [key, typeof value === 'string' ? hostEnvValue(value, env) : value]));
}

/**
 * The container form (/tmp/pwcli-<id>) of a browser session directory, given
 * either that form or its host form under CARAPA_TMP_ROOT; undefined if neither.
 */
function containerSessionDir(dir, env = process.env) {
  if (typeof dir !== 'string') return undefined;
  const tmp = tmpRoot(env);
  const name = tmp && dir.startsWith(tmp + '/') ? dir.slice(tmp.length + 1)
    : dir.startsWith('/tmp/') ? dir.slice('/tmp/'.length) : undefined;
  return name && SESSION_NAME.test(name) ? '/tmp/' + name : undefined;
}

/**
 * Directory for sockets, locks and state that is /tmp/<name> in containers and
 * under the project's tmp root on a native runner (the only place its sandbox
 * allows Unix sockets). Keep names short: macOS limits socket paths to 104 bytes.
 */
function tmpDir(name, env = process.env) {
  return `${tmpRoot(env) ?? '/tmp'}/${name}`;
}

module.exports = { nativeRoots, hostPath, hostEnvValue, hostEnv, containerSessionDir, tmpDir };
