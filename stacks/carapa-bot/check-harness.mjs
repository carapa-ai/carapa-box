#!/usr/bin/env bun
// Read-only startup check for the minimal CarapaBox controller (no Python needed).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function docker(args, capture = false) {
  const result = spawnSync('docker', args, { encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`Harness check failed: ${result.error?.message || result.stderr || 'Docker command failed'}`);
  return result.stdout;
}

try {
  const stack = path.resolve(process.argv[2] || import.meta.dirname);
  let configured;
  if (fs.existsSync(path.join(stack, '.env'))) {
    for (const line of fs.readFileSync(path.join(stack, '.env'), 'utf8').split('\n')) {
      const match = line.match(/^\s*(?:export\s+)?CARAPA_BOT_IMAGE\s*=\s*(.*?)\s*$/);
      if (match) configured = match[1].split(' #')[0].trim().replace(/^["']|["']$/g, '');
    }
  }
  const image = process.env.CARAPA_BOT_IMAGE || configured || 'carapa-bot:0.1.0';
  const selection = JSON.parse(fs.readFileSync(path.join(stack, '.harness/active/selection.json'), 'utf8'));
  if (selection.image_ref !== image) throw new Error('Image changed; select/validate a compatible harness volume with harness.py before startup');
  if (!/^carapa-harness-live-[0-9a-f]{24}$/.test(selection.volume)) throw new Error('invalid harness volume selection');
  const [info] = JSON.parse(docker(['image', 'inspect', image], true));
  if (info.Config?.Labels?.['ai.carapa.harness-layout'] !== '1') throw new Error('Incompatible public runtime image');
  if (info.Config?.Labels?.['ai.carapa.harness-store-layout'] !== '1') throw new Error('Stable harness store needs the updated runtime image; rebuild/pull it before recreating this sandbox');
  const [volume] = JSON.parse(docker(['volume', 'inspect', selection.volume], true));
  if (volume.Labels?.['ai.carapa.harness-store'] !== '1') throw new Error('Unmanaged harness volume');
  docker(['run', '--rm', '--pull=never', '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--user', '1000:1000',
    '--tmpfs', '/tmp:uid=1000,gid=1000,mode=1777', '--tmpfs', '/home/ubuntu:uid=1000,gid=1000,mode=700',
    '-e', 'PYTHONDONTWRITEBYTECODE=1', '-e', 'PI_SKIP_VERSION_CHECK=1',
    '--mount', `type=volume,src=${selection.volume},dst=/opt/carapa-harness-store,readonly,volume-nocopy`,
    '--entrypoint', '/opt/carapa-harness-store/bin/carapa-harness-exec', info.Id, 'python3', '/usr/local/lib/carapa-harness/verify.py']);
} catch (error) {
  console.error(`${error.message}\nPrepare the public image and harness selection before starting this stack.`);
  process.exitCode = 1;
}
