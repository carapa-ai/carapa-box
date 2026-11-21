#!/usr/bin/env python3
"""Stable-volume publication and conservative, boot-lease-aware collection.

This module is an operator utility, never an agent Docker client. Temporary
helpers see only this store; sandbox mounts are read-only.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import uuid

ROOT = '/opt/carapa-harness-store'
LABEL = 'ai.carapa.harness-store'
HERE = Path(__file__).resolve().parent


def run(*args, capture=False):
    return subprocess.run(args, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None,
                          stderr=subprocess.PIPE if capture else None).stdout


class Store:
    def __init__(self, volume, image):
        if not re.fullmatch(r'carapa-harness-live-[0-9a-f]{24}', volume):
            raise ValueError('Invalid stable harness volume')
        self.volume, self.image = volume, image
        self.checked = False

    @classmethod
    def named(cls, scope, image):
        return cls('carapa-harness-live-' + hashlib.sha256(scope.encode()).hexdigest()[:24], image)

    def helper(self, command, *, write=False, network='none', extra=(), capture=False, user='1000:1000', release=None):
        if not self.checked:
            info = json.loads(run('docker', 'volume', 'inspect', self.volume, capture=True))[0]
            if (info.get('Labels') or {}).get(LABEL) != '1':
                raise RuntimeError('Refusing an unmanaged stable harness volume')
            self.checked = True
        if network != 'none' and (not write or not release):
            raise ValueError('Network installers may write only an isolated candidate release')
        if release is not None and not re.fullmatch('[0-9a-f]{32}', release):
            raise ValueError('Invalid candidate release')
        candidate = (['--mount', f'type=volume,src={self.volume},dst={ROOT}/releases/{release},volume-nocopy,volume-subpath=releases/{release}'] if release else [])
        return run('docker', 'run', '--rm', '--pull=never', '--runtime', 'runc',
                   '--network', network, '--read-only', '--cap-drop', 'ALL',
                   '--security-opt', 'no-new-privileges:true', '--user', user,
                   '--tmpfs', '/tmp:uid=1000,gid=1000,mode=1777',
                   '--tmpfs', '/home/ubuntu:uid=1000,gid=1000,mode=700',
                   '-e', 'PYTHONDONTWRITEBYTECODE=1', '-e', 'PI_SKIP_VERSION_CHECK=1',
                   '--mount', f'type=volume,src={self.volume},dst={ROOT},volume-nocopy' + ('' if write and not release else ',readonly'),
                   *candidate, *extra, '--entrypoint', command[0], self.image, *command[1:], capture=capture)

    def python(self, source, *arguments, write=False, extra=(), capture=False):
        return self.helper(['python3', '-c', 'import os\n' + source, *arguments], write=write, extra=extra, capture=capture)

    def ensure(self):
        found = subprocess.run(['docker', 'volume', 'inspect', self.volume], text=True,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if found.returncode:
            run('docker', 'volume', 'create', '--label', LABEL + '=1', self.volume, capture=True)
        elif json.loads(found.stdout)[0].get('Labels', {}).get(LABEL) != '1':
            raise RuntimeError('Refusing an unmanaged stable harness volume')
        # A new volume root is root-owned and volume-nocopy never fixes it, so an
        # interrupted first setup must be repaired on every later run. Chown only
        # the labeled volume root itself, never its contents.
        if int(self.python('import sys; print(os.stat(sys.argv[1]).st_uid)', ROOT, capture=True)) != 1000:
            self.helper(['chown', '1000:1000', ROOT], write=True, user='0:0', extra=['--cap-add', 'CHOWN'])
        self.python("""
from pathlib import Path
import shutil
r=Path(os.environ.get('CARAPA_HARNESS_STORE', '/opt/carapa-harness-store'))
for d in ('releases','snapshots','bin'): (r/d).mkdir(exist_ok=True)
if not (r/'identity').exists(): (r/'identity').write_text(__import__('sys').argv[1])
# Runtime protocol is fixed for layout 1. Never overwrite an active dispatcher.
if not (r/'launch.py').exists():
 shutil.copyfile('/launch.py',r/'launch.py'); (r/'launch.py').chmod(0o755)
p=r/'bin/carapa-harness-exec'
if not p.is_symlink(): p.symlink_to(r/'launch.py')
""", self.volume, write=True,
                    extra=['--mount', f'type=bind,src={HERE / "launch.py"},dst=/launch.py,readonly'])

    def current(self):
        return json.loads(self.python("""
from pathlib import Path
import json
r=Path(os.environ.get('CARAPA_HARNESS_STORE', '/opt/carapa-harness-store'))
print((r/'snapshots'/((r/'current').read_text().strip()+'.json')).read_text() if (r/'current').exists() else '{}')
""", capture=True))

    def publish(self, entries, metadata=None):
        snapshot = uuid.uuid4().hex
        data = {'id': snapshot, 'entries': entries, **(metadata or {})}
        # Preserve a rollback entry independently for every changed harness.
        old = self.current()
        rollback = dict(old.get('rollback', {}))
        for name, entry in old.get('entries', {}).items():
            if entries.get(name) != entry: rollback[name] = entry
        data['rollback'] = rollback
        self.python("""
import json,os,sys
from pathlib import Path
r=Path(os.environ.get('CARAPA_HARNESS_STORE', '/opt/carapa-harness-store')); data=json.loads(sys.argv[1]); seen=set()
for entry in data['entries'].values():
 if not __import__('re').fullmatch('[0-9a-f]{32}',entry['release']): raise RuntimeError('Invalid release')
 release=r/'releases'/entry['release']
 if not release.is_dir(): raise RuntimeError('Missing release')
 for command,path in entry.get('commands',{}).items():
  if not __import__('re').fullmatch('[A-Za-z0-9_.+-]+',command) or command == 'carapa-harness-exec': raise RuntimeError('Invalid command')
  if command in seen: raise RuntimeError('Duplicate command: '+command)
  seen.add(command)
  target=release/path
  if not target.resolve().is_relative_to(release.resolve()) or not os.access(target,os.X_OK):
   raise RuntimeError('Invalid executable: '+str(target))
  link=r/'bin'/command
  if not link.is_symlink(): link.symlink_to(r/'launch.py')
with (r/'snapshots'/(data['id']+'.json')).open('w') as f:
 f.write(json.dumps(data)); f.flush(); os.fsync(f.fileno())
fd=os.open(r/'snapshots',os.O_RDONLY); os.fsync(fd); os.close(fd)
p=r/('current-'+data['id'])
with p.open('w') as f:
 f.write(data['id']); f.flush(); os.fsync(f.fileno())
p.replace(r/'current')
fd=os.open(r,os.O_RDONLY); os.fsync(fd); os.close(fd)
""", json.dumps(data), write=True)
        return data

    def rollback(self, names):
        old = self.current(); entries = dict(old['entries'])
        for name in names or old.get('rollback', {}):
            if name not in old.get('rollback', {}): raise ValueError('No rollback for '+name)
            entries[name] = old['rollback'][name]
        return self.publish(entries, {k: old[k] for k in ('abi', 'kind', 'image', 'layout') if k in old})

    def prune(self, apply=False):
        # Publication/collection must be serialized by the caller's operator lock.
        # Read current before inspection. New launches can only pin this snapshot
        # or a snapshot already protected by a durable boot lease.
        current = self.current()
        pinned = {current['id']}
        containers = run('docker', 'ps', '-aq', capture=True).split()
        if containers:
            try:
                inspected = json.loads(run('docker', 'inspect', *containers, capture=True))
            except (subprocess.CalledProcessError, ValueError):
                # A disposable helper may disappear between listing and inspect.
                # Keep every release instead of failing an already-published update.
                print('Cleanup skipped: container inventory changed or could not be inspected.'); return []
            for container in inspected:
                if not any(m.get('Name') == self.volume for m in container['Mounts']): continue
                state = container['State']
                if state.get('Running') and any(m.get('Name') == self.volume and m.get('RW') for m in container['Mounts']):
                    print('Cleanup skipped: a writable installer still uses the store.'); return []
                if not state.get('Running') and not state.get('Restarting'): continue
                if state.get('Paused') or state.get('Restarting'):
                    print('Cleanup skipped: a consumer is paused or restarting.'); return []
                try:
                    pins = json.loads(run('docker', 'exec', '--user', '1000:1000', container['Id'], 'python3', '-c', SCAN, self.volume, capture=True))
                except (subprocess.CalledProcessError, ValueError):
                    print('Cleanup skipped: cannot inspect a running consumer.'); return []
                if pins is None:
                    print('Cleanup skipped: a harness launch is pending.'); return []
                pinned.update(pins)
        return json.loads(self.python(COLLECT, json.dumps(sorted(pinned)), 'apply' if apply else 'preview', write=apply, capture=True))


SCAN = r"""
import json,sys
from pathlib import Path
boot=Path('/proc/1/stat').read_text().rsplit(')',1)[1].split()[19]
r=Path('/tmp/carapa-harness-leases')/sys.argv[1]/boot
pins=[p.name for p in r.iterdir()] if r.exists() else []
print(json.dumps(None if any(p.startswith('pending-') for p in pins) else pins))
"""

COLLECT = r"""
import json,re,shutil,sys
from pathlib import Path
r=Path(os.environ.get('CARAPA_HARNESS_STORE', '/opt/carapa-harness-store')); pins=json.loads(sys.argv[1]); keep=set()
for pin in pins:
 if not re.fullmatch('[0-9a-f]{32}',pin): raise RuntimeError('Unknown lease; refusing cleanup')
 data=json.loads((r/'snapshots'/(pin+'.json')).read_text())
 for e in [*data['entries'].values(),*data.get('rollback',{}).values()]: keep.add(e['release'])
removed=[]
for p in (r/'releases').iterdir():
 if re.fullmatch('[0-9a-f]{32}',p.name) and p.name not in keep:
  removed.append(p.name)
  if sys.argv[2]=='apply': shutil.rmtree(p)
if sys.argv[2]=='apply':
 for p in (r/'snapshots').glob('*.json'):
  if p.stem not in pins: p.unlink()
print(json.dumps(removed))
"""
