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

- Maintenance suite: 151 tests, 145 passed and six existing opt-in tests skipped.
- The final image-retention changes passed their 11 focused tests.
- Tests cover archive corruption, wrong image identity, container/tag races,
  registry failures, multi-architecture references, observation age, export
  headroom, filesystem isolation, dry runs, open temporary files, schedule
  preservation and notification throttling.
- All five systemd unit files passed `systemd-analyze --user verify`.
- Installed implementation and documentation match the repository files.
- Restore receipts and full machine measurements are retained privately under
  `/mnt/av-data/cache/preserved-session-artifacts/`, outside this repository.

About 372 GiB of AV worktrees remains on the root disk. Source checkouts and
experiment evidence are outside automatic cache expiration. Prefer the data
disk for future worktrees; any retirement of existing checkouts needs an
individual check for active work and uncommitted content.
