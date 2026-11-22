#!/usr/bin/env python3
"""Protect selection atomicity and the installer/runtime privilege boundary."""
import copy
import curses
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from unittest.mock import patch

STACK = Path(__file__).resolve().parents[1]


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


host = module('host', STACK / 'harness.py')
installer = module('installer', STACK / 'harness/install.py')
verifier = module('verifier', STACK / 'harness/verify.py')
tui = module('harness_tui', STACK / 'harness-tui.py')


class FakeScreen:
    """Records the text drawn per row and feeds scripted keys to App.run."""

    def __init__(self, height, keys):
        self.height = height
        self.keys = [ord(key) for key in keys]
        self.rows = {}
        self.prompts = []

    def getmaxyx(self):
        return self.height, 120

    def erase(self):
        self.rows = {}

    def addnstr(self, row, _col, text, *_args):
        self.rows[row] = text
        if text.endswith('[y/N]'):
            self.prompts.append(text)

    def getch(self):
        return self.keys.pop(0)

    def refresh(self):
        pass

    def keypad(self, _flag):
        pass

    def timeout(self, _ms):
        pass


class HarnessLifecycle(unittest.TestCase):
    def test_distribution_selection_keeps_inactive_store_and_rejects_wrong_abi(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {}, clear=True):
            stack = Path(tmp)
            debian = {'harnesses': {'claude': {'version': '1'}}, 'abi': {'libc': ['glibc']}}
            alpine = {'harnesses': {'claude': {'version': '2'}}, 'abi': {'libc': ['musl']}}
            with patch.object(host.HarnessStore, 'verify', return_value=debian):
                first = host.HarnessStore(stack).select('image-debian', 'carapa-harness-live-aaaaaaaaaaaaaaaaaaaaaaaa')
            (stack / '.env').write_text('CARAPA_BOT_IMAGE=carapa-bot:0.1.0-alpine\n')
            with patch.object(host.HarnessStore, 'verify', return_value=alpine):
                host.HarnessStore(stack).select('image-alpine', 'carapa-harness-live-bbbbbbbbbbbbbbbbbbbbbbbb')
            store = host.HarnessStore(stack, 'debian')
            self.assertEqual(store.image_ref, 'carapa-bot:0.1.0')
            self.assertEqual(store.current(), first)
            with patch.object(host.HarnessStore, 'verify', return_value=debian):
                store.select('image-debian', 'carapa-harness-live-cccccccccccccccccccccccc')
            self.assertEqual(host.HarnessStore(stack).current()['volume'], 'carapa-harness-live-bbbbbbbbbbbbbbbbbbbbbbbb')
            with patch.object(host.HarnessStore, 'verify', return_value=alpine):
                with self.assertRaisesRegex(ValueError, 'Expected a debian'):
                    store.select('image-alpine', 'carapa-harness-live-bbbbbbbbbbbbbbbbbbbbbbbb')
            self.assertEqual(store.current()['volume'], 'carapa-harness-live-cccccccccccccccccccccccc')

    def test_selection_naming_anything_but_a_live_volume_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            stack = Path(tmp)
            (stack / '.harness/active').mkdir(parents=True)
            (stack / '.harness/active/selection.json').write_text(json.dumps({'volume': 'carapa-bot-harness-' + 'a' * 32}))
            with self.assertRaisesRegex(ValueError, 'invalid harness volume selection'):
                host.HarnessStore(stack).current()
            with self.assertRaisesRegex(ValueError, 'invalid harness volume selection'):
                host.HarnessStore(stack).select('image', 'carapa-bot-harness-' + 'a' * 32)

    def test_failed_candidate_verification_does_not_publish(self):
        from unittest.mock import MagicMock
        with tempfile.TemporaryDirectory() as tmp:
            store = host.HarnessStore(Path(tmp))
            live = MagicMock()
            live.current.return_value = {'abi': {'libc': ['glibc']}, 'entries': {}}
            live.helper.side_effect = [None, subprocess.CalledProcessError(8, 'verify')]
            with patch.object(store, 'image', return_value='image'), \
                 patch.object(store, 'current', return_value=None), \
                 patch.object(store, 'container_validation'), \
                 patch.object(host, 'run', return_value=subprocess.CompletedProcess([], 0, '{"libc":["glibc"]}')), \
                 patch.object(host.LiveStore, 'named', return_value=live):
                with self.assertRaises(subprocess.CalledProcessError): store.install(['claude'])
            live.publish.assert_not_called()
            self.assertFalse((store.state / 'active').exists())

    def test_configure_retains_versions_installs_missing_and_removes_atomically(self):
        from unittest.mock import MagicMock
        abi = {'libc': ['glibc']}
        old = {n: {'release': n, 'package': {'version': '1'}} for n in ('claude', 'hermes')}
        with tempfile.TemporaryDirectory() as tmp:
            store = host.HarnessStore(Path(tmp))
            live = MagicMock(volume='test-volume')
            live.current.return_value = {'abi': abi, 'entries': old}
            new = {'release': 'antigravity', 'package': {'version': '2'}}
            with patch.object(store, 'image', return_value='image'), \
                 patch.object(store, 'current', return_value={'manifest': {'abi': abi, 'harnesses': {n: e['package'] for n, e in old.items()}}}), \
                 patch.object(store, 'read_abi', return_value=abi), \
                 patch.object(store, 'container_validation'), \
                 patch.object(store, 'select'), \
                 patch.object(store, 'install_entry', return_value=new) as install, \
                 patch.object(host.LiveStore, 'named', return_value=live):
                store.install(['claude', 'antigravity'], configure=True)
                install.assert_called_once_with(live, 'image', 'antigravity')
                self.assertEqual(live.publish.call_args.args[0], {'claude': old['claude'], 'antigravity': new})
                install.reset_mock()
                store.install(['claude@2'], configure=True)
                install.assert_called_once_with(live, 'image', 'claude@2')
                install.reset_mock()
                store.remove(['hermes'])
                install.assert_not_called()
                self.assertEqual(live.publish.call_args.args[0], {'claude': old['claude']})
                store.install(['none'], configure=True)
                self.assertEqual(live.publish.call_args.args[0], {})
                with self.assertRaisesRegex(ValueError, 'not installed'):
                    store.install(['pi'], update=True)

    def test_failed_harness_does_not_block_updating_the_others(self):
        from unittest.mock import MagicMock
        abi = {'libc': ['glibc']}
        old = {n: {'release': n, 'package': {'version': '1'}} for n in ('claude', 'prime-agent')}
        new = {'release': 'claude2', 'package': {'version': '2'}}
        with tempfile.TemporaryDirectory() as tmp:
            store = host.HarnessStore(Path(tmp))
            live = MagicMock(volume='test-volume')
            live.current.return_value = {'abi': abi, 'entries': old}
            installed = {n: e['package'] for n, e in old.items()}
            def install_entry(_live, _image, spec):
                if spec == 'prime-agent': raise subprocess.CalledProcessError(1, 'install')
                return new
            with patch.object(store, 'image', return_value='image'), \
                 patch.object(store, 'current', return_value={'manifest': {'abi': abi, 'harnesses': installed}}), \
                 patch.object(store, 'read_abi', return_value=abi), \
                 patch.object(store, 'container_validation'), \
                 patch.object(store, 'select') as select, \
                 patch.object(store, 'install_entry', side_effect=install_entry), \
                 patch.object(host.LiveStore, 'named', return_value=live):
                with self.assertRaisesRegex(RuntimeError, r'prime-agent \(kept 1, CalledProcessError\)'):
                    store.install(['claude', 'prime-agent'], update=True)
                self.assertEqual(live.publish.call_args.args[0], {'claude': new, 'prime-agent': old['prime-agent']})
                select.assert_called_once()
                live.publish.reset_mock()
                with self.assertRaises(subprocess.CalledProcessError):
                    store.install(['prime-agent'], update=True)
                live.publish.assert_not_called()

    def test_install_mounts_the_repo_antigravity_script_with_install_py(self):
        from unittest.mock import MagicMock
        live = MagicMock()
        live.helper.return_value = json.dumps({'harnesses': {'antigravity-acp': {'version': '2'}}})
        with tempfile.TemporaryDirectory() as tmp:
            store = host.HarnessStore(Path(tmp))
            with patch.object(host, 'public_entry', return_value={}):
                store.install_entry(live, 'image', 'antigravity-acp@2')
        script = STACK / 'install-antigravity-acp.sh'
        mount = f'type=bind,src={script},dst=/usr/local/lib/carapa-harness/install-antigravity-acp.sh,readonly'
        installs = [c for c in live.helper.call_args_list if c.args[0][1:2] == ['/usr/local/lib/carapa-harness/install.py']]
        self.assertEqual(len(installs), 1)
        extra = installs[0].kwargs['extra']
        self.assertIn(mount, extra)
        self.assertEqual(extra[extra.index(mount) - 1], '--mount')

    def test_opencode_selects_binaries_for_the_runtime_libc(self):
        self.assertEqual(installer.opencode_asset('x86_64', 'musl'), 'opencode-linux-x64-musl.tar.gz')
        self.assertEqual(installer.opencode_asset('aarch64', 'musl'), 'opencode-linux-arm64-musl.tar.gz')
        self.assertEqual(installer.opencode_asset('x86_64', 'glibc'), 'opencode-linux-x64.tar.gz')
        with self.assertRaises(KeyError):
            installer.opencode_asset('unknown', 'musl')

    def test_runtime_compatibility_and_executable_boundary(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            abi = root / 'abi.json'
            abi.write_text('{"layout": 1}')
            (root / 'harnesses/codex/bin').mkdir(parents=True)
            binary = root / 'harnesses/codex/bin/codex'
            binary.write_text('#!/bin/sh\nexit 0\n')
            binary.chmod(0o755)
            entries = {'codex': {'commands': ['codex'], 'version': 'test'}}
            installer.link_commands(root, entries)
            data = {'abi': {'layout': 1}, 'harnesses': entries}
            manifest = root / 'manifest.json'
            manifest.write_text(json.dumps(data))
            verifier.verify(root, abi)
            abi.write_text('{"layout": 2}')
            with self.assertRaisesRegex(RuntimeError, 'ABI mismatch'):
                verifier.verify(root, abi)
            abi.write_text('{"layout": 1}')
            binary.unlink()
            binary.symlink_to('/bin/sh')
            with self.assertRaisesRegex(RuntimeError, 'escaping'):
                verifier.verify(root, abi)

    def test_image_configuration_cannot_touch_personalized_tag_or_execute_dotenv(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {}, clear=True):
            stack = Path(tmp)
            env = stack / '.env'
            for value in ('carapa-bot-agent:latest', 'user/carapa-bot-agent:1.0', 'carapa-bot:latest', 'carapa-bot', '$(touch /tmp/unsafe)'):
                env.write_text('CARAPA_BOT_IMAGE=' + value + '\n')
                with self.assertRaises(ValueError):
                    host.image_name(stack)
            env.write_text('CARAPA_BOT_IMAGE="owner/carapa-bot:0.1.0"\nUNRELATED=$(false)\n')
            self.assertEqual(host.image_name(stack), 'owner/carapa-bot:0.1.0')
            with patch.dict(os.environ, {'CARAPA_BOT_IMAGE': 'carapa-bot:0.2.0'}):
                self.assertEqual(host.image_name(stack), 'carapa-bot:0.2.0')


class HarnessTui(unittest.TestCase):
    def run_tui(self, height, keys):
        target = tui.Target('debian', 'Debian', public=Path('/none'), stack=Path('/none'))
        screen = FakeScreen(height, keys)
        calls = []
        with patch.object(tui.Target, 'selection', return_value={}), \
                patch.object(tui, 'check_versions', return_value={}), \
                patch.object(curses, 'curs_set'), patch.object(curses, 'mousemask'), \
                patch.object(curses, 'def_prog_mode'), patch.object(curses, 'endwin'), \
                patch.object(curses, 'reset_prog_mode'), \
                patch.object(tui.subprocess, 'run', side_effect=lambda command, **_: calls.append(command)
                             or subprocess.CompletedProcess(command, 0, '', '')):
            tui.App([target]).run(screen)
        return screen, calls

    def test_short_terminal_scrolls_to_cursor_and_install_confirms_names(self):
        # 14 harnesses on 12 terminal rows: only 4 list rows are drawn.
        screen, calls = self.run_tui(12, 'j' * 13 + ' ' + 'i' + 'n' + 'q')
        self.assertIn('vibe', screen.rows[7])
        self.assertEqual(screen.prompts, ['Install vibe? [y/N]'])
        self.assertEqual(calls, [])
        screen, calls = self.run_tui(12, 'j' * 13 + ' ' + 'iy' + 'q')
        self.assertEqual(calls[0][-2:], ['install', 'vibe'])

    def test_quit_does_not_wait_for_pending_version_checks(self):
        release = threading.Event()
        self.addCleanup(release.set)
        target = tui.Target('debian', 'Debian', public=Path('/none'), stack=Path('/none'))
        # Startup check, r (refresh) and v (switch volume) all hang; q must still return.
        screen = FakeScreen(12, 'rvq')

        def hang(_names):
            release.wait(10)
            return {}

        started = time.monotonic()
        with patch.object(tui.Target, 'selection', return_value={}), \
                patch.object(tui, 'check_versions', side_effect=hang), \
                patch.object(curses, 'curs_set'), patch.object(curses, 'mousemask'):
            tui.App([target, target]).run(screen)
        self.assertLess(time.monotonic() - started, 3)

    def test_hanging_version_lookup_does_not_block_interpreter_exit(self):
        script = textwrap.dedent('''
            import importlib.util, sys, threading, time
            spec = importlib.util.spec_from_file_location('tui', sys.argv[1])
            tui = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(tui)
            tui.available_version = lambda name: time.sleep(30)
            threading.Thread(target=tui.check_versions, args=(['claude', 'codex'],), daemon=True).start()
            time.sleep(0.3)
        ''')
        started = time.monotonic()
        subprocess.run([sys.executable, '-I', '-c', script, str(STACK / 'harness-tui.py')], check=True, timeout=20)
        self.assertLess(time.monotonic() - started, 10)


if __name__ == '__main__':
    unittest.main()
