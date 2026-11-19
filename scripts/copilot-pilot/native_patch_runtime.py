"""Build configured native repairs on the verified stable Codex release."""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def patch_recipe(repo, directory):
    root = (repo / directory).resolve()
    if not root.is_relative_to(repo.resolve()):
        raise ValueError('Native patches must be committed inside the harness repository.')
    patches = sorted(root.glob('*.patch'))
    if not patches or any(not path.resolve().is_relative_to(root) for path in patches):
        raise ValueError('Configured native patches are missing or escape their directory.')
    recipe = [{'name': path.name, 'sha256': digest(path)} for path in patches]
    identifier = hashlib.sha256(json.dumps(recipe, sort_keys=True).encode()).hexdigest()
    return patches, recipe, identifier


def verify_bundle(destination, version, recipe):
    manifest = json.loads((destination / 'native-patches.json').read_text())
    binary = destination / 'bin/codex'
    if (manifest['version'] != version or manifest['patches'] != recipe
            or digest(binary) != manifest['binary_sha256']
            or digest(binary.with_name('codex-code-mode-host')) != manifest['code_mode_host_sha256']):
        raise ValueError('The immutable patched native runtime failed verification.')
    return binary, manifest


def install_patched(config, stock, version, runtime_root):
    directory = config.get('native_patch_dir')
    if directory is None:
        return stock, None
    repo = Path(config['repo'])
    patches, recipe, identifier = patch_recipe(repo, directory)
    destination = runtime_root / 'codex' / (version + '-patched-' + identifier[:16])
    if destination.exists():
        return verify_bundle(destination, version, recipe)

    build_root = runtime_root.parent / 'native-builds'
    build_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    build = Path(tempfile.mkdtemp(prefix=version + '-', dir=build_root))
    source = build / 'source'
    cargo_root = source / 'codex-rs'
    cargo = shutil.which('cargo') or str(Path.home() / '.cargo/bin/cargo')
    target = Path(config.get('native_build_target', build_root / 'target'))
    environment = {**os.environ, 'CARGO_TARGET_DIR': str(target),
                   'CARGO_BUILD_JOBS': str(config.get('native_build_jobs', 16)),
                   'CARGO_PROFILE_RELEASE_OPT_LEVEL': '1', 'CARGO_PROFILE_RELEASE_LTO': 'off',
                   'CARGO_PROFILE_RELEASE_DEBUG': '0',
                   'PATH': str(Path(cargo).parent) + os.pathsep + os.environ.get('PATH', '')}
    tag = 'rust-v' + version
    print(f'Building preserved native keyboard repairs for Codex {version}; log: {build / "build.log"}', flush=True)
    with (build / 'build.log').open('w') as log:
        def run(args, cwd=repo, **kwargs):
            return subprocess.run(args, cwd=cwd, env=environment, stdout=log,
                                  stderr=subprocess.STDOUT, check=True, timeout=3600, **kwargs)

        # Use the stable tag, not an ahead-of-release checkout, so companion
        # executables and resources still match the verified official bundle.
        run(['git', 'fetch', '--no-tags', 'upstream', f'refs/tags/{tag}:refs/tags/{tag}'])
        commit = subprocess.check_output(['git', 'rev-parse', tag + '^{commit}'], cwd=repo, text=True).strip()
        run(['git', 'worktree', 'add', '--detach', str(source), commit])
        for patch in patches:
            run(['git', 'apply', str(patch)], cwd=source)
        manifest_path = cargo_root / 'Cargo.toml'
        manifest = manifest_path.read_text()
        # Release automation stamps this workspace version before compiling.
        stamped, count = re.subn(r'(?m)^version = "0\.0\.0"$', 'version = "' + version + '"', manifest, count=1)
        if not count and not re.search(r'(?m)^version = "' + re.escape(version) + '"$', manifest):
            raise ValueError('Unrecognized native workspace release version.')
        manifest_path.write_text(stamped)
        # Release tags can stamp Cargo.toml while retaining development
        # versions for local packages in Cargo.lock. Update workspace entries
        # while keeping registry dependencies pinned, then build locked.
        run([cargo, 'update', '--workspace'], cwd=cargo_root)
        run([cargo, 'build', '--locked', '--release', '-p', 'codex-cli', '--bin', 'codex'], cwd=cargo_root)
        run([cargo, 'test', '--locked', '--release', '-p', 'codex-tui', '--lib', 'shift_home'], cwd=cargo_root)
    if not re.search(r'test result: ok\. 5 passed; 0 failed;', (build / 'build.log').read_text(errors='replace')):
        raise ValueError('The five native keyboard-selection regressions did not run successfully.')
    built = target / 'release/codex'
    actual = subprocess.check_output([str(built), '--version'], text=True, timeout=20).strip()
    if not actual.endswith(' ' + version):
        raise ValueError('Patched native executable does not report the selected stable release.')
    stage = build / 'runtime'
    shutil.copytree(stock.parent.parent, stage, symlinks=True)
    shutil.copy2(built, stage / 'bin/codex')
    manifest = {'version': version, 'upstream_commit': commit, 'patches': recipe,
                'binary_sha256': digest(stage / 'bin/codex'),
                'code_mode_host_sha256': digest(stage / 'bin/codex-code-mode-host'),
                'native_selection_tests': 'passed', 'build_log': str(build / 'build.log')}
    (stage / 'native-patches.json').write_text(json.dumps(manifest, indent=2) + '\n')
    stage.replace(destination)
    return verify_bundle(destination, version, recipe)
