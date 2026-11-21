#!/usr/bin/env python3
"""Real dispatcher/publication tests; no package downloads or credentials."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1] / 'harness'
sys.path.insert(0, str(HERE))
import live


class LocalStore(live.Store):
    """Run the exact helper programs on disposable local files instead of Docker."""
    def __init__(self, root):
        super().__init__('carapa-harness-live-' + uuid.uuid4().hex[:24], 'unused')
        self.root = root
        for d in ('bin', 'releases', 'snapshots'): (root / d).mkdir()
        (root / 'identity').write_text(self.volume)
        shutil.copyfile(HERE / 'launch.py', root / 'launch.py')
        (root / 'launch.py').chmod(0o755)
        (root / 'bin/carapa-harness-exec').symlink_to('../launch.py')
        self.env = {'PATH': os.environ['PATH'], 'CARAPA_HARNESS_STORE': str(root)}

    def helper(self, command, *, write=False, network='none', extra=(), capture=False, user=None):
        return subprocess.run(command, check=True, text=True, env=self.env,
            stdout=subprocess.PIPE if capture else None, stderr=subprocess.PIPE if capture else None).stdout

    def release(self, name, text):
        key = uuid.uuid4().hex
        root = self.root / 'releases' / key
        root.mkdir()
        script = root / name
        script.write_text('#!/bin/sh\ncat "$(dirname "$0")/value"\n')
        script.chmod(0o755)
        (root / 'value').write_text(text)
        return {'release': key, 'commands': {name: name}, 'env': {}}

    def collect(self, pins):
        return json.loads(self.python(live.COLLECT, json.dumps(pins), 'apply', write=True, capture=True))

    def pins(self):
        return json.loads(self.helper(['python3', '-c', live.SCAN, self.volume], capture=True))


class HotUpdates(unittest.TestCase):
    def test_existing_run_children_pin_old_files_and_new_run_sees_update(self):
        with tempfile.TemporaryDirectory() as directory:
            store = LocalStore(Path(directory))
            self.addCleanup(shutil.rmtree, Path('/tmp/carapa-harness-leases') / store.volume, True)
            first = store.release('claude', 'old')
            codex = store.release('codex', 'unchanged')
            one = store.publish({'claude': first, 'codex': codex})
            child = subprocess.Popen([str(store.root / 'bin/carapa-harness-exec'), sys.executable, '-u', '-c',
                'import subprocess,sys; print("ready",flush=True); sys.stdin.readline(); '
                'print(subprocess.check_output([sys.argv[1]],text=True),flush=True)', str(store.root / 'bin/claude')],
                env=store.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
            try:
                self.assertEqual(child.stdout.readline().strip(), 'ready')
                second = store.release('claude', 'new')
                two = store.publish({'claude': second, 'codex': codex})
                self.assertEqual(store.helper([str(store.root / 'bin/claude')], capture=True), 'new')
                self.assertEqual(store.helper([str(store.root / 'bin/codex')], capture=True), 'unchanged')
                # Advance again so first is neither current nor rollback.
                third = store.release('claude', 'newest')
                three = store.publish({'claude': third, 'codex': codex})
                self.assertEqual(store.collect([three['id'], *store.pins()]), [])
                child.stdin.write('\n'); child.stdin.flush()
                self.assertEqual(child.stdout.readline().strip(), 'old')
                self.assertEqual(child.wait(timeout=5), 0)
                # After a container boot ends, its leases no longer participate.
                self.assertEqual(store.collect([three['id']]), [first['release']])
                self.assertTrue((store.root / 'releases' / codex['release']).exists())
                rolled = store.rollback(['claude'])
                self.assertEqual(rolled['entries']['claude'], second)
                self.assertEqual(rolled['entries']['codex'], codex)
                self.assertEqual(rolled['rollback']['claude'], third)
                store.publish({'codex': codex})
                with self.assertRaises(subprocess.CalledProcessError):
                    store.helper([str(store.root / 'bin/claude')], capture=True)
                # A run pinned before removal still resolves its old command.
                # Use the rollback snapshot whose release has not been collected.
                store.env['CARAPA_HARNESS_SNAPSHOT'] = rolled['id']
                self.assertEqual(store.helper([str(store.root / 'bin/claude')], capture=True), 'new')
                del store.env['CARAPA_HARNESS_SNAPSHOT']
                restored = store.rollback(['claude'])
                self.assertEqual(restored['entries']['claude'], second)

            finally:
                if child.poll() is None: child.kill(); child.wait()
                child.stdin.close(); child.stdout.close()

    def test_invalid_publication_keeps_selection_and_cleanup_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            store = LocalStore(Path(directory))
            self.addCleanup(shutil.rmtree, Path('/tmp/carapa-harness-leases') / store.volume, True)
            first = store.release('claude', 'old')
            one = store.publish({'claude': first})
            broken = store.release('claude', 'bad')
            (store.root / 'releases' / broken['release'] / 'claude').unlink()
            with self.assertRaises(subprocess.CalledProcessError): store.publish({'claude': broken})
            self.assertEqual(store.current()['id'], one['id'])
            self.assertEqual(store.collect([one['id']]), [broken['release']])
            # A paused/restarting consumer or failed scan must stop collection.
            container = {'Id': 'sandbox', 'Mounts': [{'Name': store.volume}], 'State': {'Running': True, 'Paused': True}}
            with patch.object(live, 'run', side_effect=['vanished', subprocess.CalledProcessError(1, 'inspect')]):
                self.assertEqual(store.prune(True), [])
            with patch.object(live, 'run', side_effect=['sandbox', json.dumps([container])]):
                self.assertEqual(store.prune(True), [])
            container['State']['Paused'] = False
            with patch.object(live, 'run', side_effect=['sandbox', json.dumps([container]), subprocess.CalledProcessError(1, 'scan')]):
                self.assertEqual(store.prune(True), [])
            with patch.object(live, 'run', side_effect=['sandbox', json.dumps([container]), 'null']):
                self.assertEqual(store.prune(True), [])

    def test_failed_launch_does_not_leave_a_pending_marker_that_blocks_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            store = LocalStore(Path(directory))
            self.addCleanup(shutil.rmtree, Path('/tmp/carapa-harness-leases') / store.volume, True)
            store.publish({'claude': store.release('claude', 'old')})
            for pin in ('not-hex', uuid.uuid4().hex):  # invalid value, then missing snapshot JSON
                store.env['CARAPA_HARNESS_SNAPSHOT'] = pin
                with self.assertRaises(subprocess.CalledProcessError):
                    store.helper([str(store.root / 'bin/claude')], capture=True)
                self.assertEqual(store.pins(), [])
            del store.env['CARAPA_HARNESS_SNAPSHOT']

    def test_pi_launch_adds_mcp_adapter_when_settings_json_is_invalid(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'store').mkdir()
            store = LocalStore(root / 'store')
            self.addCleanup(shutil.rmtree, Path('/tmp/carapa-harness-leases') / store.volume, True)
            release = store.release('pi', '')
            (store.root / 'releases' / release['release'] / 'pi').write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
            store.publish({'pi': release})
            adapter = root / 'adapter'
            adapter.mkdir()
            (adapter / 'index.ts').write_text('')
            agent = root / 'agent'
            agent.mkdir()
            (agent / 'settings.json').write_text('{"packages": [')  # syntax error
            store.env.update({'CARAPA_PI_MCP_ADAPTER': str(adapter), 'PI_CODING_AGENT_DIR': str(agent)})
            out = store.helper([str(store.root / 'bin/pi'), 'hello'], capture=True)
            self.assertEqual(out.split(), ['--extension', str(adapter / 'index.ts'), 'hello'])
            # A valid settings file that already lists the adapter still suppresses the extension.
            (agent / 'settings.json').write_text('{"packages": ["npm:pi-mcp-adapter"]}')
            self.assertEqual(store.helper([str(store.root / 'bin/pi'), 'hello'], capture=True).split(), ['hello'])

    def test_ensure_repairs_root_owned_store_left_by_an_interrupted_first_setup(self):
        calls, owner = [], [0]

        class FakeStore(live.Store):
            def helper(self, command, *, user='1000:1000', **options):
                calls.append((command[0], user))
                if command[0] == 'chown': owner[0] = 1000
                return str(owner[0]) if command[0] == 'python3' and options.get('capture') else ''

        store = FakeStore('carapa-harness-live-' + uuid.uuid4().hex[:24], 'unused')
        found = subprocess.CompletedProcess([], 0, json.dumps([{'Labels': {live.LABEL: '1'}}]), '')
        with patch.object(subprocess, 'run', return_value=found):
            store.ensure()
            store.ensure()
        self.assertEqual([c for c in calls if c[0] == 'chown'], [('chown', '0:0')])


if __name__ == '__main__': unittest.main()
