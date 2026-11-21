import type { RunContext } from '../contracts';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Older fresh Pi tasks used the provider's cwd-scoped default directory.
 * Copy only the explicitly requested native session; leave that shared source
 * intact because other projects may still use it during the storage cutover. */
export function adoptLegacyPiSession(context: RunContext, sessionId: string): void {
  if (!/^[\w-]{1,128}$/.test(sessionId)) return;
  const target = join(dirname(dirname(context.runDir)), 'pi-sessions');
  const matches = (dir: string) => existsSync(dir) ? readdirSync(dir).filter(name =>
    name.endsWith(`_${sessionId}.jsonl`) && lstatSync(join(dir, name)).isFile()) : [];
  if (matches(target).length) return;
  const agentHome = context.env.PI_CODING_AGENT_DIR || join(context.env.HOME || '/home/ubuntu', '.pi', 'agent');
  const encoded = `--${resolve(context.cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  const source = join(agentHome, 'sessions', encoded);
  const candidates = matches(source);
  if (candidates.length > 1) throw new Error('Multiple legacy Pi files match the requested native session');
  if (!candidates.length) return; // Native --session reports missing history.
  const file = join(source, candidates[0]);
  const header = JSON.parse(readFileSync(file, 'utf8').split('\n', 1)[0]);
  if (header.type !== 'session' || header.id !== sessionId || resolve(header.cwd) !== resolve(context.cwd)) {
    throw new Error('Legacy Pi session identity does not match the requested workspace');
  }
  mkdirSync(target, { recursive: true, mode: 0o700 });
  copyFileSync(file, join(target, candidates[0]), constants.COPYFILE_EXCL);
}
