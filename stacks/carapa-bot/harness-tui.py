#!/usr/bin/env python3
"""Interactive harness-volume manager shared by the public and personal stacks.

The installer backends remain deliberately separate because the personal Debian
volume has a different ABI and lifecycle. This file owns the operator-facing
selection UI and dispatches to those tested backends.
"""
from __future__ import annotations

import argparse
import curses
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
from urllib.parse import quote
from urllib.request import urlopen


HERE = Path(__file__).resolve().parent
NAMES = (
    'antigravity', 'antigravity-acp', 'claude', 'codex', 'cursor', 'grok',
    'hermes', 'muse', 'omp', 'opencode', 'pi', 'playwright', 'prime-agent', 'vibe',
)
UNSUPPORTED_ALPINE = {'antigravity-acp', 'cursor', 'grok', 'muse', 'omp', 'vibe'}
PINNED = {'playwright': '0.1.24', 'grok': '1.0.52', 'vibe': '3.1.0'}
NPM = {
    'claude': '@anthropic-ai/claude-code', 'codex': '@openai/codex',
    'omp': '@oh-my-pi/pi-coding-agent', 'opencode': None,
    'pi': '@earendil-works/pi-coding-agent', 'playwright': '@playwright/cli',
}
PIP = {'antigravity': 'google-antigravity', 'hermes': 'hermes-agent[acp]', 'vibe': 'mistral-vibe'}
LOG = Path(tempfile.gettempdir()) / f'carapa-harness-last-{os.getuid()}.log'


def load_install_module():
    path = HERE / 'harness/install.py'
    spec = importlib.util.spec_from_file_location('carapa_harness_install', path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f'Cannot load harness catalog: {path}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_version(command: list[str], timeout: float = 12) -> str | None:
    try:
        result = subprocess.run(command, check=True, text=True, capture_output=True, timeout=timeout)
        return result.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def pypi_latest(package: str) -> str | None:
    """Read the canonical release version from PyPI's JSON API.

    ``pip index versions`` can be served by a stale or incomplete package
    index.  The JSON endpoint is the authoritative package metadata and is
    also independent of the Python environment used to run this TUI.
    """
    try:
        url = f'https://pypi.org/pypi/{quote(package, safe="")}/json'
        with urlopen(url, timeout=12) as response:
            payload = json.load(response)
        version = payload.get('info', {}).get('version')
        return str(version) if version else None
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None


def available_version(name: str) -> str | None:
    """Resolve an upstream version without touching a harness volume."""
    if name in PINNED:
        return PINNED[name]
    if name in NPM and NPM[name]:
        value = run_version(['npm', 'view', NPM[name], 'version', '--json'])
        if value:
            try:
                return str(json.loads(value))
            except json.JSONDecodeError:
                return value.strip('"')
    if name in PIP:
        return pypi_latest(PIP[name].split('[', 1)[0])
    if name in ('opencode', 'antigravity-acp'):
        repo = 'anomalyco/opencode' if name == 'opencode' else 'google-antigravity/antigravity-cli'
        output = run_version(['curl', '-fsSL', f'https://api.github.com/repos/{repo}/releases/latest'])
        if output:
            try:
                return str(json.loads(output)['tag_name'])
            except (KeyError, json.JSONDecodeError):
                return None
    # Cursor and Prime intentionally use upstream installer "latest" channels.
    return None


def check_versions(names: list[str]) -> dict[str, str | None]:
    """Look up upstream versions on daemon threads.

    Daemon threads (unlike ThreadPoolExecutor workers, which the interpreter
    joins at exit) never delay quitting the TUI while a slow lookup is pending.
    """
    results: dict[str, str | None] = {}
    pending = list(names)

    def worker() -> None:
        while True:
            try:
                name = pending.pop()
            except IndexError:
                return
            try:
                results[name] = available_version(name)
            except Exception:
                results[name] = None

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(min(6, max(1, len(names))))]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return results


def numeric_version(value: str | None) -> tuple[int, ...] | None:
    """Return a conservative comparable key for ordinary release versions."""
    if not value:
        return None
    match = re.match(r'^v?(\d+(?:\.\d+)+)', value)
    return tuple(int(part) for part in match.group(1).split('.')) if match else None


def safe_available(current: str | None, available: str | None) -> tuple[str | None, bool]:
    """Never display a registry result below the installed release."""
    current_key = numeric_version(current)
    available_key = numeric_version(available)
    if current_key and available_key and available_key < current_key:
        return current, True
    return available, False


def version_status(current: str | None, available: str | None, name: str, alpine: bool,
                   installed: bool | None = None) -> str:
    if alpine and name in UNSUPPORTED_ALPINE:
        return 'unsupported on Alpine'
    if installed is None:
        installed = current is not None
    if not installed:
        return 'not installed'
    if available is None:
        return 'latest channel' if name in ('cursor', 'muse', 'prime-agent') else 'check unavailable'
    if current.lstrip('v') == available.lstrip('v'):
        return 'current'
    return 'update available'


def read_personal_selection(root: Path) -> dict:
    path = root / 'stacks/.harness/active/current.json'
    return json.loads(path.read_text()) if path.exists() else {}


def read_public_selection(root: Path, stack: Path, variant: str) -> dict:
    command = [sys.executable, str(root / 'harness.py'), '--stack-dir', str(stack), '--variant', variant, 'status']
    try:
        result = subprocess.run(command, check=True, text=True, capture_output=True, timeout=35)
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return {}


class Target:
    def __init__(self, key: str, label: str, *, personal: Path | None = None,
                 public: Path | None = None, stack: Path | None = None):
        self.key = key
        self.label = label
        self.personal = personal
        self.public = public
        self.stack = stack
        self.variant = 'debian' if key == 'debian' else 'alpine'

    @property
    def alpine(self) -> bool:
        return self.variant == 'alpine'

    def selection(self) -> dict:
        if self.personal:
            return read_personal_selection(self.personal)
        return read_public_selection(self.public, self.stack, self.variant)

    def command(self, action: str, names: list[str], *, apply: bool = False) -> list[str]:
        names = names or ['none'] if action == 'configure' else names
        if self.personal:
            backend = self.personal / 'scripts/harness-volume.py'
            return [sys.executable, str(backend), 'prune' if action == 'cleanup' else action,
                    *(['--apply'] if apply else []), *names]
        backend = self.public / 'harness.py'
        return [sys.executable, str(backend), '--stack-dir', str(self.stack),
                '--variant', self.variant, 'cleanup' if action == 'cleanup' else action,
                *(['--apply'] if apply else []), *names]


class App:
    def __init__(self, targets: list[Target]):
        self.targets = targets
        self.target_index = 0
        self.rows = list(NAMES)
        self.cursor = 0
        self.top = 0
        self.checked: set[str] = set()
        self.available: dict[str, str | None] = {}
        self.selection: dict = {}
        self.message = 'Checking upstream versions…'
        self.running = False
        self.check_generation = 0
        self.refresh()

    @property
    def target(self) -> Target:
        return self.targets[self.target_index]

    def refresh(self) -> None:
        self.selection = self.target.selection()
        # Checkboxes are an explicit action selection. Installed harnesses are
        # shown in the Installed column but must never be selected implicitly.
        self.checked.clear()
        self.available = {}
        self.message = f'Checking versions for {self.target.label}…'

    def check_versions(self, generation: int) -> None:
        available = check_versions(self.rows)
        if generation != self.check_generation:
            return  # superseded by a newer check or a volume switch
        self.available = available
        # Keep an install/update result visible; replace only the progress text.
        if self.message.startswith('Checking'):
            self.message = 'Ready. No harnesses selected. Space/click toggles; a selects all compatible harnesses.'

    def start_check(self) -> None:
        """Run a version check in the background so keys (q) stay responsive."""
        self.check_generation += 1
        threading.Thread(target=self.check_versions, args=(self.check_generation,), daemon=True).start()

    def confirm(self, stdscr, prompt: str) -> bool:
        """Require an explicit confirmation before changing the active set."""
        height, width = stdscr.getmaxyx()
        stdscr.addnstr(max(0, height - 2), 0, prompt + ' [y/N]', width - 1, curses.A_BOLD)
        stdscr.refresh()
        stdscr.timeout(-1)
        try:
            return stdscr.getch() in (ord('y'), ord('Y'))
        finally:
            stdscr.timeout(100)

    def switch_target(self) -> None:
        self.target_index = (self.target_index + 1) % len(self.targets)
        self.cursor = 0
        self.refresh()
        self.start_check()

    def selected_installed(self) -> list[str]:
        installed = set(self.selection.get('manifest', {}).get('harnesses', {}))
        return [name for name in self.rows if name in self.checked and name in installed]

    def selected_missing(self) -> list[str]:
        installed = set(self.selection.get('manifest', {}).get('harnesses', {}))
        return [name for name in self.rows if name in self.checked and name not in installed]

    def invoke(self, stdscr, action: str, names: list[str] | None = None, *, apply: bool = False) -> bool:
        names = names or []
        if action != 'cleanup' and not names and action != 'configure':
            self.message = 'No checked harnesses.'
            return False
        command = self.target.command(action, names, apply=apply)
        self.running = True
        curses.def_prog_mode(); curses.endwin()
        try:
            result = subprocess.run(command, text=True, capture_output=True)
            text = result.stdout + result.stderr
            LOG.touch(mode=0o600)
            LOG.write_text('$ ' + ' '.join(command) + '\n\n' + text)
            output = text.strip().splitlines()
            self.message = (output[-1] if output else f'{action} finished')
            if result.returncode:
                # The last line is usually the backend's wrapped docker command;
                # the harness's own "error:" line says what actually went wrong.
                errors = [line.strip() for line in output if re.match(r'\s*error\b', line, re.I)]
                self.message = f'FAILED ({result.returncode}), press l for the full log: {(errors or [self.message])[-1]}'
        except OSError as error:
            self.message = f'FAILED: {error}'
        finally:
            curses.reset_prog_mode(); self.running = False
        outcome = self.message
        self.refresh()
        self.message = outcome
        return True

    def show_log(self) -> None:
        if not LOG.exists():
            self.message = 'No log yet: run an install or update first.'
            return
        curses.def_prog_mode(); curses.endwin()
        try:
            subprocess.run([os.environ.get('PAGER', 'less'), str(LOG)])
        except OSError as error:
            self.message = f'Cannot open the log {LOG}: {error}'
        finally:
            curses.reset_prog_mode()

    @staticmethod
    def visible_count(height: int) -> int:
        """Rows that fit between the table header (row 3) and the footer."""
        return max(0, height - 8)

    def scroll_to_cursor(self, height: int) -> None:
        """Scroll the list window so the cursor is always a drawn row."""
        visible = max(1, self.visible_count(height))
        self.top = max(0, min(self.top, len(self.rows) - visible))
        if self.cursor < self.top:
            self.top = self.cursor
        elif self.cursor >= self.top + visible:
            self.top = self.cursor - visible + 1

    def draw(self, stdscr) -> None:
        stdscr.erase()
        height, width = stdscr.getmaxyx()
        self.scroll_to_cursor(height)
        title = f' Carapa Harnesses — {self.target.label} '
        stdscr.addnstr(0, 0, title, width - 1, curses.A_BOLD)
        volume = self.selection.get('volume', 'not configured')
        stdscr.addnstr(1, 0, f'Volume: {volume}', width - 1)
        stdscr.addnstr(3, 0, '  Harness             Installed        Available        Status', width - 1, curses.A_UNDERLINE)
        installed = self.selection.get('manifest', {}).get('harnesses', {})
        for row, name in enumerate(self.rows[self.top:self.top + self.visible_count(height)], 4):
            current = installed.get(name, {}).get('version') if isinstance(installed.get(name), dict) else None
            available, registry_older = safe_available(current, self.available.get(name))
            status = version_status(current, available, name, self.target.alpine, name in installed)
            if registry_older and status == 'current':
                status = 'current (registry older)'
            mark = 'x' if name in self.checked else ' '
            attr = curses.A_REVERSE if row - 4 + self.top == self.cursor else 0
            if self.target.alpine and name in UNSUPPORTED_ALPINE: attr |= curses.A_DIM
            text = f' [{mark}] {name:<18} {str(current or "—"):<15} {str(available or "—"):<15} {status}'
            stdscr.addnstr(row, 0, text, width - 1, attr)
        footer = height - 3
        stdscr.addnstr(footer, 0, self.message, width - 1, curses.A_BOLD)
        stdscr.addnstr(footer + 1, 0, '↑↓ move  Space toggle  i install  u update  d remove  c exact set  r/R refresh  b rollback  p/P cleanup  l log  v volume  q quit', width - 1)
        stdscr.refresh()

    def run(self, stdscr) -> None:
        curses.curs_set(0); stdscr.keypad(True); stdscr.timeout(100)
        try:
            curses.mousemask(curses.ALL_MOUSE_EVENTS | curses.REPORT_MOUSE_POSITION)
        except curses.error:
            pass
        self.start_check()
        while True:
            self.draw(stdscr)
            key = stdscr.getch()
            if key < 0: continue
            if key == curses.KEY_MOUSE:
                try:
                    _, _x, y, _, button = curses.getmouse()
                except curses.error:
                    continue
                if button & (curses.BUTTON1_CLICKED | curses.BUTTON1_DOUBLE_CLICKED):
                    row = y - 4
                    if 0 <= row < self.visible_count(stdscr.getmaxyx()[0]) and row + self.top < len(self.rows):
                        row += self.top
                        self.cursor = row
                        name = self.rows[row]
                        if not (self.target.alpine and name in UNSUPPORTED_ALPINE):
                            self.checked.symmetric_difference_update({name})
                continue
            if key in (ord('q'), 27): return
            if key in (curses.KEY_DOWN, ord('j')): self.cursor = min(len(self.rows) - 1, self.cursor + 1)
            elif key in (curses.KEY_UP, ord('k')): self.cursor = max(0, self.cursor - 1)
            elif key == ord(' '):
                name = self.rows[self.cursor]
                if not (self.target.alpine and name in UNSUPPORTED_ALPINE):
                    self.checked.symmetric_difference_update({name})
            elif key == ord('a'): self.checked = set(self.rows) - (UNSUPPORTED_ALPINE if self.target.alpine else set())
            elif key == ord('n'): self.checked.clear()
            elif key == ord('l'): self.show_log()
            elif key == ord('v'): self.switch_target()
            elif key in (ord('r'), ord('R')):
                self.refresh(); self.start_check()
            elif key in (ord('i'), ord('u')):
                action = 'install' if key == ord('i') else 'update'
                names = self.selected_missing() if key == ord('i') else self.selected_installed()
                if not names:
                    self.message = 'No checked harnesses.'
                elif not self.confirm(stdscr, f'{action.capitalize()} ' + ', '.join(names) + '?'):
                    self.message = f'{action.capitalize()} cancelled.'
                elif self.invoke(stdscr, action, names):
                    self.start_check()
            elif key == ord('d'):
                names = self.selected_installed()
                if names and self.confirm(stdscr, 'Remove ' + ', '.join(names) + '?'):
                    if self.invoke(stdscr, 'remove', names): self.start_check()
                elif names:
                    self.message = 'Remove cancelled.'
                elif not names:
                    self.message = 'No checked installed harnesses.'
            elif key == ord('c'):
                names = [n for n in self.rows if n in self.checked]
                installed = set(self.selection.get('manifest', {}).get('harnesses', {}))
                removed = sorted(installed - set(names))
                if removed and not self.confirm(stdscr, 'Configure exact set; remove ' + ', '.join(removed) + '?'):
                    self.message = 'Configure cancelled.'
                elif self.invoke(stdscr, 'configure', names):
                    self.start_check()
            elif key == ord('b'):
                if self.invoke(stdscr, 'rollback', self.selected_installed()): self.start_check()
            elif key == ord('p'):
                if self.invoke(stdscr, 'cleanup'): self.start_check()
            elif key == ord('P'):
                if self.invoke(stdscr, 'cleanup', apply=True): self.start_check()


def build_targets(args) -> list[Target]:
    if args.personal_root:
        root = args.personal_root.resolve()
        box = Path(os.environ.get('CARAPA_BOX_DIR', root.parent / 'carapa-box')).resolve()
        return [Target('debian', 'Debian — shared CarapaBot volume', personal=root),
                Target('alpine', 'Alpine — CarapaBox Bot volume', public=box / 'stacks/carapa-bot',
                       stack=root / 'stacks/carapa-box-bot')]
    public = (args.public_root or HERE).resolve()
    stack = (args.stack_dir or public).resolve()
    return [Target('debian', 'Debian — public CarapaBot volume', public=public, stack=stack),
            Target('alpine', 'Alpine — public CarapaBot volume', public=public, stack=stack)]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--personal-root', type=Path, help='my-stacks root; exposes the shared personal Debian and Alpine volumes')
    parser.add_argument('--public-root', type=Path, help='carapa-box/stacks/carapa-bot root')
    parser.add_argument('--stack-dir', type=Path, help='consumer stack containing .harness state')
    parser.add_argument('--target', choices=('debian', 'alpine'), help='start on one volume')
    args = parser.parse_args()
    app = App(build_targets(args))
    if args.target: app.target_index = 0 if args.target == 'debian' else 1; app.refresh()
    curses.wrapper(app.run)


if __name__ == '__main__':
    main()
