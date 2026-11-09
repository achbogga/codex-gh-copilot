"""Install cleanup timers, retaining unrelated cron entries and prior files."""

import datetime
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


CRON_BLOCKS = ('daily developer cache cleanup', 'root disk pressure check')


def remove_cleanup_blocks(crontab):
    lines = crontab.splitlines(keepends=True)
    result = []
    current = None
    for line in lines:
        if current is None and line.rstrip() in {f'# BEGIN managed {name}' for name in CRON_BLOCKS}:
            current = line.rstrip().removeprefix('# BEGIN managed ')
        elif current is not None and line.rstrip() == f'# END managed {current}':
            current = None
        elif current is None:
            result.append(line)
    if current is not None:
        raise ValueError('Incomplete managed cron block; refusing to replace crontab')
    return ''.join(result)


def install(source, destination, backup, mode=0o644):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        shutil.copy2(destination, backup / destination.name)
    with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(source.read_bytes())
        stream.flush();os.fsync(stream.fileno())
    temporary.chmod(mode)
    temporary.replace(destination)


def main():
    root = Path(__file__).resolve().parent
    home = Path.home()
    linger = subprocess.check_output(['loginctl', 'show-user', str(os.getuid()), '-p', 'Linger', '--value'], text=True).strip()
    if linger != 'yes':
        raise RuntimeError('Enable user lingering before replacing cron with timers')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = home / '.local/state/dev-cache-cleanup' / ('install-backup-' + stamp)
    backup.mkdir(parents=True, exist_ok=True)
    library = home / '.local/lib/dev-cache-cleanup'
    # Install new imports before the entry point so a concurrent invocation can
    # never see a cleanup.py whose required modules are not installed yet.
    files = {'preserve_oci.py': 'preserve_oci.py', 'docker_image_retention.py': 'docker_image_retention.py',
             'worktree_cleanup.py': 'worktree_cleanup.py',
             'create_worktree.py': 'create_worktree.py',
             'notify_cleanup_failure.py': 'notify_cleanup_failure.py',
             'dev_cache_cleanup.py': 'cleanup.py', 'cache-cleanup.md': 'README.md'}
    for source, target in files.items():
        install(root / source, library / target, backup)
    install(root / 'dev-cache-cleanup.sh', home / '.local/bin/dev-cache-cleanup', backup, 0o755)
    install(root / 'dev-worktree.sh', home / '.local/bin/dev-worktree', backup, 0o755)
    units = home / '.config/systemd/user'
    unit_sources = (sorted(root.glob('dev-cache-cleanup-*.service'))
                    + sorted(root.glob('dev-cache-cleanup-*.timer'))
                    + sorted(root.glob('dev-worktree-cleanup.*')))
    for source in unit_sources:
        install(source, units / source.name, backup)
    subprocess.run(['systemd-analyze', '--user', 'verify',
                    *[str(units / source.name) for source in unit_sources]], check=True)
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
    timers = ['dev-cache-cleanup-pressure.timer', 'dev-cache-cleanup-daily.timer']
    if (home / '.config/dev-cache-cleanup/worktrees.json').is_file():
        timers.append('dev-worktree-cleanup.timer')
    subprocess.run(['systemctl', '--user', 'enable', '--now', *timers], check=True)
    for timer in timers:
        subprocess.run(['systemctl', '--user', 'is-active', '--quiet', timer], check=True)
    # Only remove duplicate jobs after the replacement timers are active.
    old = subprocess.check_output(['crontab', '-l'], text=True)
    new = remove_cleanup_blocks(old)
    (backup / 'crontab').write_text(old)
    if subprocess.check_output(['crontab', '-l'], text=True) != old:
        raise RuntimeError('Crontab changed during installation; preserved it')
    if new != old:
        subprocess.run(['crontab', '-'], input=new, text=True, check=True)
    print(f'Cleanup timers installed; previous files and crontab: {backup}')


if __name__ == '__main__':
    main()
