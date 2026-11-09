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

## Storage-efficient creation

An isolated Git experiment at one Lance producer commit measured 2,412.79 MiB
for a full checkout, 15.11 MiB for focused Lance review directories, and
387.51 MiB for broader ML source inspection. These are checkout-only savings of
99.37% and 83.94%; neither sparse profile has been qualified for Bazel builds.
All probe checkouts were removed after clean-state and sibling-isolation checks.
The two ext4 filesystems rejected copy-on-write reflink probes.

`dev-worktree` is installed. Its configured creation root is
`/mnt/av-data/cache/av-worktrees`, with a 200 GiB free-space reserve. Review
creation requires explicit directories and includes `.github` instructions;
full checkouts require `--full`. Existing worktree paths remain registered.
Retirement covers both the old home root and the new data root. It accepts
intentionally absent sparse entries while retaining existing hidden files.

The installed helper created a clean 4.56 MiB documentation-review checkout on
the data disk, verified that existing full checkouts stayed full, and removed
its disposable checkout through native Git. Git sparse configuration uses native
per-worktree settings. The maintenance suite now runs 165 tests: 159 pass and
six existing opt-in tests are skipped. Tests cover creation scope, path escape,
branch isolation, duplicate destinations, both cleanup roots and hidden sparse edits.

Existing shared Bazel disk/repository caches remain on the data disk. Workspace
output bases remain isolated. The repository wrapper's fetched-content-cache
and remote-output compatibility guards are preserved. No active worktree was
moved or converted to a sparse build profile.

## Reclaiming existing checkouts

The follow-up audit measured 357.98 GiB under the home worktree root. Existing
shared Bazel caches do not deduplicate these source files. Twenty-two retained
checkouts occupied 52.89 GiB and had commits absent from saved remote refs.
Five of those also had fresh generated `.autogen.bazelrc` files, which were the
only recent filesystem changes in the first inspected checkout.

The installed worker now supports a shared, independent bare Git archive for
local-only history. The host enables this option and excludes exactly the ignored
`.autogen.bazelrc` file from activity dating. Other age, ownership, PR, edit and
concurrency checks still apply. Archives and recovery refs do not expire.

The committed maintenance snapshot runs 169 tests: 163 pass and six existing
opt-in tests are skipped. Eighteen worktree tests include independent recovery
of local commits and LFS assets, missing/corrupt LFS media, failed preservation,
and activity exemptions that must not apply to tracked files or directory contents.
The full suite was also rerun in an isolated checkout to exclude concurrent
control-center changes from this verification.

The completed sweep removed 24 checkouts and retained 108, with no errors.
Removed allocations totaled 57.75 GiB; independent Git/LFS recovery archives,
ignored files and metadata occupy 3.40 GiB, for a net storage saving of 54.35 GiB.
All 24 recovery refs and local archive checksums were verified again, all retired
paths are absent, and the independent commit archive passed a connectivity check.
The original shared LFS cache remains intact. Root free space measured 229.28 GiB
after verification, with utilization at 75%; unrelated development jobs remained
active. All 11 original Screen sessions and all 17 running containers were present.
The existing daily retirement timer remains active at 04:17 UTC.
