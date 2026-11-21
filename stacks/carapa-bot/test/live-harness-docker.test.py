#!/usr/bin/env python3
"""Opt-in local Docker/runsc smoke: no credentials, network or live sandboxes.
Run: python3 live-harness-docker.test.py [runtime-image ...]
"""
import json
from pathlib import Path
import subprocess
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'harness'))
from live import Store, ROOT, run


def exercise(image, runtime):
    store = Store.named('disposable-test-' + uuid.uuid4().hex, image)
    name = 'carapa-harness-test-' + uuid.uuid4().hex[:12]
    try:
        store.ensure()
        def release(value):
            key = uuid.uuid4().hex
            store.python('from pathlib import Path; import sys; r=Path(sys.argv[1]); r.mkdir(); '
                '(r/"value").write_text(sys.argv[2]); '
                '(r/"claude").write_text(\'#!/bin/sh\\ncat "$(dirname "$0")/value"\\n\'); '
                '(r/"claude").chmod(0o755)', ROOT + '/releases/' + key, value, write=True)
            return {'release': key, 'commands': {'claude': 'claude'}, 'env': {}}
        first = release('old')
        one = store.publish({'claude': first})
        run('docker', 'run', '-d', '--name', name, '--runtime', runtime, '--network', 'none',
            '--read-only', '--cap-drop', 'ALL', '--user', '1000:1000',
            '--tmpfs', '/tmp:uid=1000,gid=1000,mode=1777',
            '--mount', f'type=volume,src={store.volume},dst={ROOT},readonly,volume-nocopy',
            '--mount', f'type=volume,src={store.volume},dst=/opt/carapa-harness/bin,readonly,volume-nocopy,volume-subpath=bin',
            '--entrypoint', 'sleep', image, 'infinity', capture=True)
        identity = run('docker', 'inspect', '--format', '{{.Id}}', name, capture=True)
        run('docker', 'exec', '-d', name, '/opt/carapa-harness/bin/carapa-harness-exec', 'python3', '-c',
            'from pathlib import Path; import time,subprocess; Path("/tmp/ready").touch(); '
            '\nwhile not Path("/tmp/go").exists(): time.sleep(.05)\n'
            'Path("/tmp/result").write_text(subprocess.check_output(["/opt/carapa-harness/bin/claude"],text=True))')
        run('docker', 'exec', name, 'python3', '-c',
            'from pathlib import Path; import time; deadline=time.time()+10\n'
            'while not Path("/tmp/ready").exists():\n assert time.time()<deadline; time.sleep(.05)')
        second = release('new')
        store.publish({'claude': second})
        assert run('docker', 'exec', name, '/opt/carapa-harness/bin/claude', capture=True) == 'new'
        third = release('newest')
        current = store.publish({'claude': third})
        assert store.prune(True) == [], 'deleted a release leased by a running boot'
        run('docker', 'exec', name, 'touch', '/tmp/go')
        result = run('docker', 'exec', name, 'python3', '-c',
            'from pathlib import Path; import time; deadline=time.time()+10\n'
            'while not Path("/tmp/result").exists():\n assert time.time()<deadline; time.sleep(.05)\n'
            'print(Path("/tmp/result").read_text(),end="")', capture=True)
        assert result == 'old', result
        assert run('docker', 'inspect', '--format', '{{.Id}}', name, capture=True) == identity
        assert run('docker', 'exec', name, '/opt/carapa-harness/bin/claude', capture=True) == 'newest'
        # A candidate installer can write its own directory but not active code.
        candidate = uuid.uuid4().hex
        store.python('from pathlib import Path; import sys; Path(sys.argv[1]).mkdir()', ROOT + '/releases/' + candidate, write=True)
        store.helper(['sh', '-ec', 'touch "$1/new"; ! touch "$2/unsafe"', 'sh',
            ROOT + '/releases/' + candidate, ROOT + '/releases/' + third['release']], write=True, release=candidate)
        assert store.prune(True) == [candidate]
        run('docker', 'rm', '-f', name, capture=True)
        assert store.prune(True) == [first['release']]
        rolled = store.rollback(['claude'])
        assert rolled['entries']['claude'] == second
        print(f'PASS {image} / {runtime}: same container, pinned children, atomic update, read-only old files, safe cleanup, rollback', flush=True)
    finally:
        subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['docker', 'volume', 'rm', store.volume], check=True, stdout=subprocess.DEVNULL)


if __name__ == '__main__':
    for image in sys.argv[1:] or ['carapa-bot:0.1.0', 'carapa-bot:0.1.0-alpine']:
        for runtime in ('runc', 'runsc'): exercise(image, runtime)
