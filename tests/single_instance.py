"""Verify native single-instance behavior in an isolated Linux D-Bus session."""
from pathlib import Path
import os, subprocess, sys, tempfile, time
ROOT = Path(__file__).resolve().parents[1]
if '--private-session' not in sys.argv:
    subprocess.run(['dbus-run-session', '--', sys.executable, str(Path(__file__).resolve()), '--private-session'], check=True)
    raise SystemExit(0)

with tempfile.TemporaryDirectory(prefix='undertone-instance-', dir=ROOT / '.tools') as folder:
    directory = Path(folder)
    env = os.environ.copy()
    for key, name in [('XDG_DATA_HOME', 'data'), ('XDG_CACHE_HOME', 'cache'), ('XDG_CONFIG_HOME', 'config')]:
        env[key] = str(directory / name)
    with (directory / 'startup.log').open('w') as log:
        first = subprocess.Popen([str(ROOT / 'dist/linux/Undertone')], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 20
            service = 'personal.undertone.player.SingleInstance'
            while True:
                assert first.poll() is None, 'The first app closed before it was ready'
                owner = subprocess.run(['gdbus', 'call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.GetConnectionUnixProcessID', service], capture_output=True, text=True, env=env)
                if owner.returncode == 0 and str(first.pid) in owner.stdout:
                    break
                assert time.monotonic() < deadline, 'The app did not register its single-instance service'
                time.sleep(0.1)
            # Let the first window and native audio process finish starting.
            time.sleep(1)
            for command in [[str(ROOT / 'dist/linux/Undertone')], [str(ROOT / 'run.sh')]]:
                second = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=8)
                assert second.returncode == 0, 'A repeated launch did not exit cleanly'
                assert first.poll() is None, 'A repeated launch closed the original app'
            children = set()
            for path in Path(f'/proc/{first.pid}/task').glob('*/children'):
                children.update(path.read_text().split())
            players = []
            for pid in children:
                path = Path(f'/proc/{pid}/cmdline')
                if path.exists() and Path(path.read_bytes().split(b'\0')[0].decode()).name == 'mpv':
                    players.append(pid)
            assert len(players) == 1, f'Expected one native audio player; got {len(players)}'
            print('Three launches left one native app and one audio player; duplicate processes exited cleanly.')
        finally:
            first.terminate()
            try:
                first.wait(timeout=5)
            except subprocess.TimeoutExpired:
                first.kill(); first.wait()
