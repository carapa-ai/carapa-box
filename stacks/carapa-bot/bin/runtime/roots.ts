/**
 * Filesystem roots of the agent runtime.
 *
 * Inside a sandbox container the layout is fixed: IPC at /workspace/ipc, the
 * project group directory at /workspace/group and repositories under
 * /workspace. A native runner (no container) maps those container paths onto
 * host directories with CARAPA_IPC_ROOT, CARAPA_GROUP_ROOT and
 * CARAPA_WORKSPACE_ROOT. Unset variables keep the container layout, so
 * container runs are unchanged.
 */
const CONTAINER_IPC = '/workspace/ipc';
const CONTAINER_GROUP = '/workspace/group';
const CONTAINER_WORKSPACE = '/workspace';

export function ipcRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.CARAPA_IPC_ROOT || CONTAINER_IPC;
}

function mapPrefix(value: string, prefix: string, target: string | undefined): string | null {
  if (!target) return null;
  if (value === prefix) return target;
  if (value.startsWith(`${prefix}/`)) return target + value.slice(prefix.length);
  return null;
}

/** Translate a container path to the host path a native runner uses (identity in containers). */
export function hostPath(value: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!value.startsWith(CONTAINER_WORKSPACE)) return value;
  return mapPrefix(value, CONTAINER_IPC, env.CARAPA_IPC_ROOT)
    ?? mapPrefix(value, CONTAINER_GROUP, env.CARAPA_GROUP_ROOT)
    ?? mapPrefix(value, CONTAINER_WORKSPACE, env.CARAPA_WORKSPACE_ROOT)
    ?? value;
}

/** True when this runtime runs natively with mapped roots. */
export function nativeRoots(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.CARAPA_IPC_ROOT || env.CARAPA_GROUP_ROOT || env.CARAPA_WORKSPACE_ROOT);
}

// A standalone /workspace path root: not part of a longer path or URL (left) nor a longer name like /workspaces (right).
const CONTAINER_WORKSPACE_IN_TEXT = /(?<![\w./:~-])\/workspace(?:\/[^\s"'`)\]]*)?(?=$|[\s"'`)\]]|[.,;:!?]+(?:\s|$))/g;

/** Rewrite container paths inside free text (prompts) for a native runner. */
export function hostPathsInText(text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!nativeRoots(env)) return text;
  return text.replace(CONTAINER_WORKSPACE_IN_TEXT, match => hostPath(match, env));
}

// Browser daemon directories Board places in the container's /tmp.
const CONTAINER_BROWSER_TMP = '/tmp/pwcli-';
const CONTAINER_RELAY = /^(https?|wss?):\/\/api-relay:8080(?=\/|$)/;
const CONTAINER_LLAMA = /^http:\/\/llama-proxy:(\d+)(?=\/|$)/;

/**
 * Translate an environment value Board wrote for a container: api-relay URLs
 * go to the native runner's relay forwarder, llama-proxy URLs to the runner's
 * local model proxy behind it (/llama-proxy/<port>), browser daemon directories under
 * /tmp/pwcli-* to the project's own temporary root (the only place its sandbox
 * allows Unix sockets), and
 * container paths to host paths. Identity in containers.
 */
export function hostEnvValue(value: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!nativeRoots(env)) return value;
  const relay = CONTAINER_RELAY.exec(value);
  if (relay && env.CARAPA_RELAY_URL) {
    const base = relayBaseUrl(env);
    return (relay[1].startsWith('ws') ? base.replace(/^http/, 'ws') : base) + value.slice(relay[0].length);
  }
  const llama = CONTAINER_LLAMA.exec(value);
  if (llama && env.CARAPA_RELAY_URL) {
    return `${relayBaseUrl(env)}/llama-proxy/${llama[1]}${value.slice(llama[0].length)}`;
  }
  if (env.CARAPA_TMP_ROOT && value.startsWith(CONTAINER_BROWSER_TMP)) {
    return `${env.CARAPA_TMP_ROOT.replace(/\/+$/, '')}/${value.slice('/tmp/'.length)}`;
  }
  return hostPath(value, env);
}

/** Rewrite relay and llama-proxy URLs inside harness config files for a native runner. */
export function hostUrlsInText(text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!nativeRoots(env)) return text;
  return text.replace(/\b(?:https?|wss?):\/\/(?:api-relay:8080|llama-proxy:\d+)(?![\w.:-])/g, match => hostEnvValue(match, env));
}

/** Base URL of the credential relay (api-relay in containers, a local forwarder natively). */
export function relayBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.CARAPA_RELAY_URL || 'http://api-relay:8080').replace(/\/+$/, '');
}
