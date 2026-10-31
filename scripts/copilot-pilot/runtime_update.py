#!/usr/bin/env python3
"""Install verified stable Linux runtimes without replacing running executables."""

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request


def get(url, limit=4 * 1024**2):
    if url.startswith('https://api.github.com/') and shutil.which('gh'):
        # Use the normal GitHub CLI login rather than exhausting the shared
        # unauthenticated IP allowance. Never read or print its credential.
        body = subprocess.check_output(['gh', 'api', url.removeprefix('https://api.github.com/')],
                                       stderr=subprocess.PIPE, timeout=45)
    else:
        request = urllib.request.Request(url, headers={'User-Agent': 'codex-copilot-updater'})
        with urllib.request.urlopen(request, timeout=45) as response:
            body = response.read(limit + 1)
    if len(body) > limit:
        raise ValueError('Release metadata exceeded its size bound.')
    return body


def stable_release(repository):
    release = json.loads(get(f'https://api.github.com/repos/{repository}/releases/latest'))
    if release.get('draft') or release.get('prerelease'):
        raise ValueError('Refusing a non-stable release.')
    match = re.fullmatch(r'(?:rust-)?v?(\d+\.\d+\.\d+)', release['tag_name'])
    if not match:
        raise ValueError('Unrecognized stable release tag.')
    return match[1], release


def download(url, destination, algorithm, expected):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        temporary = destination.with_suffix('.download')
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'codex-copilot-updater'})
            with urllib.request.urlopen(request, timeout=90) as response, temporary.open('wb') as output:
                shutil.copyfileobj(response, output, 1024 * 1024)
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
    with destination.open('rb') as source:
        digest = hashlib.file_digest(source, algorithm).digest()
    actual = base64.b64encode(digest).decode() if algorithm == 'sha512' else digest.hex()
    if actual != expected:
        raise ValueError('Runtime download checksum mismatch.')
    return destination


def unpack(archive, destination):
    if destination.exists():
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.runtime-', dir=destination.parent))
    try:
        with tarfile.open(archive) as package:
            # Python's data filter rejects escapes and unsafe link targets.
            package.extractall(stage, filter='data')
        stage.replace(destination)
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def atomic_text(path, text, mode=0o600):
    temporary = path.with_name('.' + path.name + '.update')
    temporary.write_text(text)
    temporary.chmod(mode)
    temporary.replace(path)


def atomic_link(path, target):
    temporary = path.with_name('.' + path.name + '.update')
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(target)
    temporary.replace(path)


def installed_version(binary):
    return subprocess.check_output([str(binary), '--version'], text=True, timeout=20).strip()


def codex_entries(config, home):
    """Validate all explicitly managed launcher paths before changing any of them."""
    extra = config.get('codex_entries', [])
    if not isinstance(extra, list) or not all(isinstance(path, str) for path in extra):
        raise ValueError('codex_entries must be a list of launcher paths.')
    primary = config.get('codex_entry', shutil.which('codex') or home / '.local/bin/codex')
    entries = list(dict.fromkeys(Path(path) for path in [primary, *extra]))
    for entry in entries:
        parent = entry.parent.resolve()
        if not entry.is_absolute() or (parent != home.resolve() and home.resolve() not in parent.parents):
            raise ValueError('Refusing a Codex entrypoint outside the user home.')
    return entries


def point_codex_entries(entries, codex, cache):
    atomic_text(cache / 'codex-entries-before.json', json.dumps([
        {'path': str(entry), 'link': os.readlink(entry) if entry.is_symlink() else None}
        for entry in entries], indent=2))
    for entry in entries:
        atomic_link(entry, codex)


def install(config, cache):
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise ValueError('This installer currently supports Linux x86_64 only.')
    task_home = Path.home()
    entries = codex_entries(config, task_home)
    repo = Path(config['repo'])
    runtime_root = Path(config.get('runtime_root', task_home / '.local/share/codex-copilot/runtimes'))
    runtime_root.mkdir(parents=True, exist_ok=True)
    launcher = task_home / '.local/bin/codex-copilot'
    wrapper = launcher.read_text()
    exec_line = next(line for line in wrapper.splitlines() if line.startswith('exec '))
    node = Path(shlex.split(exec_line)[1])
    with ThreadPoolExecutor(max_workers=4) as pool:
        codex_lookup = pool.submit(stable_release, 'openai/codex')
        copilot_lookup = pool.submit(stable_release, 'github/copilot-cli')
        sdk_lookup = pool.submit(get, 'https://registry.npmjs.org/@github%2fcopilot-sdk/latest')
        node_lookup = pool.submit(get, 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt')
        codex_version, codex_release = codex_lookup.result()
        copilot_version, copilot_release = copilot_lookup.result()
        sdk_version = json.loads(sdk_lookup.result())['version']
        node_checksum = next(line.split() for line in node_lookup.result().decode().splitlines()
                             if line.endswith('-linux-x64.tar.xz'))
    if not re.fullmatch(r'\d+\.\d+\.\d+', sdk_version):
        raise ValueError('Refusing an unrecognized SDK version.')
    native = json.loads(get('https://registry.npmjs.org/@openai%2fcodex/' + codex_version + '-linux-x64'))
    algorithm, digest = native['dist']['integrity'].split('-', 1)
    if algorithm != 'sha512':
        raise ValueError('Missing expected npm SHA-512 integrity.')
    copilot_asset = next(asset for asset in copilot_release['assets'] if asset['name'] == 'copilot-linux-x64.tar.gz')
    digest_type, copilot_digest = copilot_asset['digest'].split(':', 1)
    if digest_type != 'sha256':
        raise ValueError('Missing expected GitHub SHA-256 digest.')
    with ThreadPoolExecutor(max_workers=2) as pool:
        a = pool.submit(download, native['dist']['tarball'], cache / ('codex-' + codex_version + '.tgz'), 'sha512', digest)
        b = pool.submit(download, copilot_asset['browser_download_url'], cache / ('copilot-' + copilot_version + '.tar.gz'), 'sha256', copilot_digest)
        native_archive, copilot_archive = a.result(), b.result()
    codex_root = runtime_root / 'codex' / codex_version
    copilot_root = runtime_root / 'copilot' / copilot_version
    unpack(native_archive, codex_root)
    unpack(copilot_archive, copilot_root)
    codex = codex_root / 'package/vendor/x86_64-unknown-linux-musl/bin/codex'
    copilot = copilot_root / 'copilot'
    if not codex.with_name('codex-code-mode-host').is_file():
        raise ValueError('The native Code Mode companion is missing.')
    if codex_version not in installed_version(codex) or copilot_version not in installed_version(copilot):
        raise ValueError('Installed binary version did not match its stable release.')
    node_version = re.fullmatch(r'node-v(22\.\d+\.\d+)-linux-x64.tar.xz', node_checksum[1])[1]
    old_node = node
    if node_version not in installed_version(node):
        node_archive = download('https://nodejs.org/dist/v' + node_version + '/' + node_checksum[1],
                                cache / node_checksum[1], 'sha256', node_checksum[0])
        node_root = runtime_root / 'node' / node_version
        unpack(node_archive, node_root)
        node = node_root / ('node-v' + node_version + '-linux-x64/bin/node')
        if node_version not in installed_version(node):
            raise ValueError('Installed Node version mismatch.')
    npm = node.parent.parent / 'lib/node_modules/npm/bin/npm-cli.js'
    if not npm.is_file():
        raise ValueError('The selected Node installation does not contain npm.')
    old_codex = str(config['codex_bin'])
    wrappers = []
    for name in ('codex-copilot', 'codex-copilot-docker'):
        path = launcher.with_name(name)
        text = path.read_text()
        if old_codex not in text or str(old_node) not in text:
            raise ValueError('A launcher differs from the managed runtime configuration.')
        wrappers.append((path, text, text.replace(old_codex, str(codex)).replace(str(old_node), str(node))))
    # Preserve the installation inputs before changing pointers or SDK files.
    atomic_text(cache / 'launchers-before.json', json.dumps({str(p): old for p, old, _ in wrappers}, indent=2))
    package = repo / 'scripts/copilot-pilot/package.json'
    current_sdk = json.loads(package.read_text())['dependencies']['@github/copilot-sdk']
    installed_sdk_file = package.parent / 'node_modules/@github/copilot-sdk/package.json'
    installed_sdk = json.loads(installed_sdk_file.read_text()).get('version') if installed_sdk_file.exists() else None
    if current_sdk != sdk_version or installed_sdk != sdk_version:
        environment = {**os.environ, 'PATH': str(node.parent) + os.pathsep + os.environ.get('PATH', '')}
        subprocess.run([str(node), str(npm), 'install', '--prefix', str(package.parent),
                        '--ignore-scripts', '--save-exact', '@github/copilot-sdk@' + sdk_version],
                       env=environment, check=True, timeout=180)
    copilot_entry = Path(config['copilot_bin'])
    if copilot_entry.exists() and not copilot_entry.is_symlink():
        # Keep the original inode for running processes and explicit rollback.
        backup = cache / 'copilot-before'
        if not backup.exists():
            os.link(copilot_entry, backup) if copilot_entry.stat().st_dev == cache.stat().st_dev else shutil.copy2(copilot_entry, backup)
    atomic_link(copilot_entry, copilot)
    point_codex_entries(entries, codex, cache)
    for path, _, text in wrappers:
        atomic_text(path, text, 0o700)
    config.update({'codex_bin': str(codex), 'node_bin': str(node), 'runtime_root': str(runtime_root),
                   'codex_entry': str(entries[0])})
    report = {'codex': codex_version, 'copilot_cli': copilot_version, 'copilot_sdk': sdk_version,
              'node': node_version, 'codex_bin': str(codex), 'copilot_bin': str(copilot),
              'node_bin': str(node), 'immutable_runtime_root': str(runtime_root),
              'codex_entries_updated': len(entries),
              'codex_sha512_verified': True, 'copilot_sha256_verified': True,
              'old_running_executables_overwritten': False}
    atomic_text(cache / 'runtime-install.json', json.dumps(report, indent=2) + '\n')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--cache-dir', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    args.cache_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    config = json.loads(args.config.read_text())
    report = install(config, args.cache_dir)
    atomic_text(args.config, json.dumps(config, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
