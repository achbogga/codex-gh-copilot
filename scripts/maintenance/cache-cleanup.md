# Host cache cleanup

The active schedule uses **systemd user timers**: a daily sweep at 03:47 UTC
and a root-pressure check every five minutes. Both invoke
`~/.local/bin/dev-cache-cleanup`, installed from `dev-cache-cleanup.sh`.
Timers persist across reboots; user lingering keeps them working after logout.
The Python modules are installed together under `~/.local/lib/dev-cache-cleanup/`.

Run `python3 scripts/maintenance/install_cache_cleanup.py` from the harness repo
to install or update them. The installer backs up existing files and the crontab,
verifies units, starts both timers, and then removes only the two obsolete managed
cleanup cron blocks. Session-recovery cron jobs remain intact. It refuses the
schedule migration unless user lingering is already enabled.

## Bazel

The daily sweep covers recognized output bases under
`/mnt/av-data/cache/bazel/_bazel_aboggaram` and the corresponding home cache
path. It empties bases unused for 24 hours, retaining their lock inode. A live
server, a held Bazel fcntl lock, or recent use prevents removal; those conditions
are rechecked under the lock. Shared disk/repository caches expire only while
all known output bases are idle. Unknown directories are preserved: this host
also has worktrees, experiment evidence and OCI snapshots inside its Bazel root.

The October 27 daily run emptied ten inactive output bases. The data-volume
Bazel cache cleanup was functioning; it could not free the separate root disk.

The legacy root-owned `/etc/cron.d/dev-cache-cleanup-aboggaram` lacks its final
newline. Cron explicitly ignores it, as recorded in the September 21 journal.
Its `/usr/local/sbin/dev-cache-cleanup-aboggaram` also targets the old, absent
home Bazel output root. **Do not reactivate that obsolete script.** An
administrator can retire that cron file; the user timers are the working
replacement and do not require sudo.

## Tagged Docker images

The five-minute check records tagged image use even while disk space is healthy.
Seven days of
observations are required; an image referenced by any running or stopped container,
a tag change, or an observation gap over two days resets eligibility. Docker's
`Created` timestamp is deliberately ignored because reproducible builds can give
new images a years-old timestamp.

Under root disk pressure, eligible images are reclaimed until 160 GiB is free.
Registry-backed images need an immutable manifest whose config digest matches the
local image ID, including platform selection for multi-architecture manifests.
An unavailable registry keeps its image locally. Local-only images are exported
to the data disk; the config and every saved layer are verified against the
image ID and layer diff IDs. Archives retain a 200 GiB data-volume reserve, and
exports require root staging headroom for Docker's transient layer copies.
Docker storage on a different filesystem is excluded from root-pressure recovery.

Restore receipts are written before removal under
`/mnt/av-data/cache/preserved-session-artifacts/docker-images/`. Container and tag
references are rechecked; removal never uses `--force`. Images with multiple tags
are retained because deleting their ID requires force. Containers and volumes
are never removed. An interrupted export leaves the original image and a partial
archive; a later eligible run retries it. Archives have no automatic expiration.

Restore an image and its original tags with:

```sh
python3 ~/.local/lib/dev-cache-cleanup/docker_image_retention.py --restore /path/to/receipt.json
```

Restoration verifies identity and refuses to overwrite a tag that now names a
different image. `--reclaim-unused-images-now` on the cleanup command bypasses
only the observation grace period for an explicitly requested recovery; scheduled
services never pass it. Verification, container checks and preservation still apply.

## Pip scratch files

The sweeps remove user-owned `pip-unpack-*`, `pip-build-tracker-*` and
`pip-ephem-wheel-cache-*` trees in `/tmp` after seven days without modifications.
Bounded inventories reject symlinks, mounts, special files and other owners.
Open process references and container mounts prevent deletion; the inventory is
rechecked before removal. Other temporary files, worktrees and experiment evidence
are outside this policy.

## Root pressure

Below 120 GiB free, the pressure job prunes eligible root-resident caches and
preserves eligible temporary OCI snapshots on the data disk, targeting 160 GiB
free. Filesystem filtering happens after symlink resolution, so links below
`~/.cache` cannot accidentally send root-pressure cleanup into data-volume caches.
The daily sweep also reports failure when root space remains below 120 GiB.

Snapshot preservation is restricted to user-owned `/tmp/sml*-oci-*` and
`/tmp/sml*-train-oci-*` directories with an OCI layout and no changes for seven
days. It skips symlinks, special files, keep markers, live process references,
container mounts and other owners. The data disk must retain 200 GiB free.
The bounded inventory validates layout metadata, and rsync checksums verify
the entire copied tree before an atomic directory-to-symlink exchange. Original
paths continue to work. No retained snapshot is expired or treated as disposable
cache; these snapshots can be inputs to later jobs.

Copies, path switches and duplicate removal have durable receipts under
`/mnt/av-data/cache/preserved-session-artifacts/cron-oci/receipts`. A subsequent
run resumes an interrupted copy or removal, including when root space has
already recovered. A changed source or mismatched copy is retained for inspection.
Preservation has a shared lock across daily and pressure jobs. Existing retained
archives and native session histories remain outside cache expiration.

The pressure launcher has a 30-minute limit and low best-effort I/O priority;
the daily sweep retains its six-hour limit and idle I/O priority. Failed exits,
including timeouts, fail the systemd service and appear in its journal. `OnFailure`
sends a local desktop notification at most once per hour. Notification attempts
remain recorded even when no graphical desktop is available.

## Inspection

```sh
dev-cache-cleanup --pressure --dry-run
dev-cache-cleanup --dry-run
systemctl --user list-timers 'dev-cache-cleanup-*'
systemctl --user status dev-cache-cleanup-pressure.service
journalctl --user -u dev-cache-cleanup-pressure.service
cat ~/.local/state/dev-cache-cleanup/last-pressure-run.json
```

`daily.log` rotates at 5 MiB with three backups. `last-run.json` and
`last-pressure-run.json` record timestamps, thresholds, before/after free space,
status and failed tasks. The compatible text markers remain available.
Unrelated crontab entries are preserved when migrating the managed cleanup blocks.
