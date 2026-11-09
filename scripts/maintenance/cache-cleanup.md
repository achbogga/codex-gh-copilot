# Host cache cleanup

The active schedule uses **systemd user timers**: a daily sweep at 03:47 UTC
and a root-pressure check every five minutes. Both invoke
`~/.local/bin/dev-cache-cleanup`, installed from `dev-cache-cleanup.sh`.
Timers persist across reboots; user lingering keeps them working after logout.
The Python modules are installed together under `~/.local/lib/dev-cache-cleanup/`.
An independently scheduled worktree sweep runs daily at 04:17 UTC when its
explicit host configuration is installed.

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

## Git worktrees

`dev-worktree-cleanup.timer` runs at **04:17 UTC**. It removes actual checkout
directories, whereas `git worktree prune` only removes stale registration metadata.
It is separate from cache pressure cleanup: source retirement never accelerates
because the disk is full. The main checkout and directories outside the configured
worktree root are excluded.

The job keeps open PRs, unknown branches, dirty/untracked files,
unarchived thread working directories, Git locks/operations, `.keep-worktree`
markers, explicitly protected paths, live process references and container mounts.
It also keeps checkouts with changes in the last fourteen days. Branch checkouts
require a confirmed closed/merged PR older than seven days; detached checkouts
require the same fourteen-day inactivity window. By default, local-only commits
are retained unless reachable from a saved remote-tracking ref. GitHub errors or truncated results
prevent the affected removal; all authors' open PR heads are checked, including
when a local branch has a different name.

Before removing a checkout, the job creates a permanent Git recovery ref and
archives **all ignored files** plus per-worktree Git metadata. It verifies file
contents, preserves symlinks without following them, and rechecks registration,
activity and cleanliness. Deletion uses `git worktree remove` without force;
branches are retained. Archives larger than two GiB, unsafe filesystem entries,
submodules and special index flags require manual inspection. The archive disk
must retain 200 GiB free. Neither recovery refs nor archives expire automatically.
Interrupted preservation leaves the original checkout and a receipt. A removal
interrupted after verification remains recoverable through that receipt and ref.

The explicit JSON configuration at `~/.config/dev-cache-cleanup/worktrees.json`
contains absolute paths for `repository`, `worktree_root`, `archive_root`,
`state_dir`, `protected_paths` and `thread_databases`, plus the GitHub
`owner/repository` in `github_repository`. Keep durable infrastructure worktrees
(such as the maintained wiki) in `protected_paths`. The installer only enables
the timer when this configuration exists. It never sources checkout environment
scripts, which can launch builds as a side effect of a status check.
Thread database paths may use `state_*.sqlite` patterns so new runtime schema
versions are included. A missing or unreadable configured database prevents removal.
`worktree_roots` accepts multiple managed roots; the previous singular
`worktree_root` remains supported. Sparse worktrees are eligible only when every
skip-worktree entry is intentionally absent. Existing hidden files and
assume-unchanged entries remain protected.

Optional `archive_local_commits: true` lets otherwise eligible checkouts retire
after copying their complete commit history into `archive_root/commits.git`.
This independent bare Git repository shares objects across retirement archives;
it has no dependency on the source repository's object files. Native fetch
checks incoming objects and connectivity and flushes committed Git state before
the receipt records the exact archived recovery ref. Fetch or verification
failure keeps the checkout. This does not bypass PR, ownership, edit or age checks.
This option requires Git LFS. The archive also copies the retired tree's LFS
objects from the configured local media store and verifies every SHA-256. Missing
or corrupt objects prevent removal. Archived LFS storage is repository-relative
and independent of the original shared cache; no network LFS download is attempted.

`activity_ignored_files` can list exact generated filenames whose regeneration
does not represent task activity. The host lists only `.autogen.bazelrc`, which
the AV Bazel wrapper generates. An exclusion applies only to an ignored regular
file, never a tracked file or recursively to a directory. The file is still
archived and included in concurrent-change checks before removal.

### Creating smaller worktrees

`dev-worktree` uses native Git to create new checkouts under the configured
`creation_root`, which must be one of `worktree_roots`. The host places new
checkouts on its development data disk; existing working directories stay registered
at their current paths. `creation_min_free_bytes` reserves filesystem headroom.
Optional `review_paths` adds the repository's instruction directories to each
sparse checkout. No branch names, task names or language packages are hardcoded.

```sh
dev-worktree review-example --ref origin/example-branch --path path/to/package
dev-worktree editing-example --ref origin/main --branch new-editing-branch --full
```

Pass existing repository-relative directories with repeated `--path` arguments.
Reviews default to detached, cone-mode sparse checkouts with an ordinary index.
Use `--branch` to create a new branch. Full checkouts require `--full`; sparse
profiles need target-level qualification before use for builds/tests. Creation
does not run environment hooks or launch builds. Load the new checkout's own
environment before running repository tools. Native Git stores sparse settings
per worktree; a failure preserves the new checkout for inspection.

The creator and retirement sweep share a lock. Receipts under `state_dir` record
the selected commit, paths and branch. Ordinary Git commands continue to work;
this helper only supplies safer placement and explicit checkout scope.

Inspect eligibility or the latest completed run:

```sh
python3 ~/.local/lib/dev-cache-cleanup/worktree_cleanup.py --config ~/.config/dev-cache-cleanup/worktrees.json
systemctl --user list-timers dev-worktree-cleanup.timer
journalctl --user -u dev-worktree-cleanup.service
cat ~/.local/state/dev-cache-cleanup/last-worktree-run.json
```

Each removal records its original path, branch, HEAD, recovery ref and archive
checksum in `archive_root/<checkout>-<id>/receipt.json`. To restore, use
`git worktree add --detach <new-path> <recovery-ref>` from the original repository,
then extract only the archive's `ignored/` subtree into that checkout with
`tar -xf <archive>/local-files.tar --strip-components=1 -C <new-path> ignored`.
Use a fresh destination and inspect the receipt first. `git-metadata/` preserves
the old index and reflog for inspection; do not overwrite the new `.git` setup.
For a receipt with `commit_archive`, the independent archive can also restore
source after loss of the original repository:
`git --git-dir=<commit_archive> worktree add --detach <new-path> <recovery-ref>`.
Then restore ignored files as above. Commit archives and recovery refs do not
expire automatically.

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
