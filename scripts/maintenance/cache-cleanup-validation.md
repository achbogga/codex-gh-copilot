# Host cleanup verification — 2026-11-09

Root free space increased from approximately 16.5 GiB to 165.5 GiB, recovering
149 GiB and reducing utilization from 99% to 82%. The data disk retains about
2.1 TiB free. These are point-in-time measurements; other development jobs remain active.

Reclaimed 4.74 GiB of abandoned pip unpack downloads and 23 unused tagged Docker
images. Twenty-one images have verified immutable registry restore references.
Two local-only images were exported to 34.4 GiB of archives on the data disk;
their config identities and every layer diff ID were verified before removal.
All nine original Screen sessions and all 17 originally running containers remain
present and running. No containers or volumes were deleted.

The previously active daily and five-minute cron jobs ran, but their coverage
excluded tagged Docker images and pip scratch directories. The separate legacy
system cron file is obsolete, has no final newline, and points to the old Bazel
location. It remains disabled; an administrator can retire that root-owned file.

The new user timers are enabled with persistent scheduling and existing user
lingering: daily at 03:47 UTC and pressure checks every five minutes. Duplicate
managed cleanup cron blocks were removed; the three unrelated session-recovery
jobs were preserved. The pressure service succeeded both on direct invocation
and on its scheduled 16:55 UTC run. The next full daily sweep is scheduled;
it was not rerun as part of this root-disk recovery.

Validation:

- Maintenance suite after worktree automation: 162 tests, 156 passed and six
  existing opt-in tests skipped.
- The final image-retention changes passed their 11 focused tests.
- Tests cover archive corruption, wrong image identity, container/tag races,
  registry failures, multi-architecture references, observation age, export
  headroom, filesystem isolation, dry runs, open temporary files, schedule
  preservation and notification throttling.
- All seven systemd unit files passed `systemd-analyze --user verify`.
- Installed implementation and documentation match the repository files.
- Restore receipts and full machine measurements are retained privately under
  `/mnt/av-data/cache/preserved-session-artifacts/`, outside this repository.

## Worktree retirement follow-up

There was no scheduled PR-aware worktree retirement. The empty `av.worktrees`
directory was removed, along with one empty abandoned directory inside the actual
`av-worktrees` root. The actual checkouts occupied approximately 372 GiB before
this follow-up; they are separate Git working copies, not build caches.

The new `dev-worktree-cleanup.timer` is enabled with a persistent daily schedule
at 04:17 UTC. Its first service run completed successfully at 17:31 UTC:
six checkouts removed, 131 retained, no errors. One removed checkout belonged
to a merged PR; five were inactive detached review/test copies. Their allocated
size was 14.30 GiB, and root free space increased by 14.34 GiB during the run.
The final root measurement was 175.2 GiB free; other development jobs remain active.

All six recovery refs resolve to the original HEADs. Their ignored files and
per-worktree Git metadata occupy 77.85 MiB in verified archives on the data disk.
Archive checksums, absent retired paths and retained refs were checked again after
removal. All nine original Screens and all 17 originally running containers were
still present, and the unrelated recovery crontab entries were unchanged.

Retained checkouts include local changes, commits absent from saved remote refs,
open/recent PRs, recent use, the maintained wiki, and branches without confirmed
closed PRs. Four additional old directories point to missing Git metadata under
an already deleted temporary repository; they were preserved because their
contents cannot be proved disposable. A separate clone and experiment evidence
outside the registered set were also retained.

Eleven worktree-specific tests use disposable Git repositories and cover recovery,
ignored-file archives, symlink isolation, local-only commits, GitHub errors and
truncation, hidden index changes, live files, threads (including new database
versions), recent metadata changes, locks, concurrent edits and preservation
failures. The installed worker, notification helper, documentation and units match
the source files. Private audit details and recovery receipts remain under
`/mnt/av-data/cache/preserved-session-artifacts/`.
