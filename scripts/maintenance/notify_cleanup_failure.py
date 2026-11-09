"""Send the local user at most one cleanup-failure notification per hour."""

import json
from pathlib import Path
import shutil
import subprocess
import time

import preserve_oci


def main():
    state = Path.home() / '.local/state/dev-cache-cleanup'
    state.mkdir(parents=True, exist_ok=True)
    receipt = state / 'last-notification.json'
    now = time.time()
    previous = json.loads(receipt.read_text()) if receipt.exists() else {}
    if 0 <= now - previous.get('attempted_at', 0) < 3600:
        return
    free = shutil.disk_usage('/').free / 1024**3
    # Keep a durable record even without an attached graphical desktop.
    preserve_oci.save(receipt, {'attempted_at': now, 'root_free_gib': free})
    message = (f'Root disk has {free:.1f} GiB free. Inspect systemctl --user --failed, '
               'the failed cleanup service journal, and ~/.local/state/dev-cache-cleanup/.')
    print(message)
    result = subprocess.run(['/usr/bin/notify-send', '--urgency=critical',
                             'Developer disk cleanup needs attention', message],
                            timeout=10, check=False)
    preserve_oci.save(receipt, {'attempted_at': now, 'root_free_gib': free,
                              'desktop_delivered': result.returncode == 0})


if __name__ == '__main__':
    main()
