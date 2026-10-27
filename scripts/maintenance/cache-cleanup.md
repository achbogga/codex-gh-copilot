# Host cache cleanup

The active schedule is aboggaram's **user crontab**: a daily sweep at 03:47 UTC
and a cheap root-pressure check every five minutes. Both invoke
`~/.local/bin/dev-cache-cleanup`, installed from `dev-cache-cleanup.sh`.
The Python implementation and `preserve_oci.py` are installed together under
`~/.local/lib/dev-cache-cleanup/`.

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
administrator can retire that cron file; the user crontab is the working
replacement and does not require sudo.

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
including timeouts, reach cron's stderr log. They are not reported as success.

## Inspection

```sh
dev-cache-cleanup --pressure --dry-run
dev-cache-cleanup --dry-run
cat ~/.local/state/dev-cache-cleanup/last-pressure-run.json
tail ~/.local/state/dev-cache-cleanup/cron-errors.log
```

`daily.log` rotates at 5 MiB with three backups. `last-run.json` and
`last-pressure-run.json` record timestamps, thresholds, before/after free space,
status and failed tasks. The compatible text markers remain available.
Unrelated crontab entries are preserved when updating the managed cleanup blocks.
