import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--source', default='HEAD')
parser.add_argument('--packer', help='packer revision (defaults to the source revision)')
parser.add_argument('--out', type=Path)
parser.add_argument('--worktree', action='store_true', help='overlay current Teams sources, including new nonignored files')
args = parser.parse_args()
repo = Path(__file__).resolve().parents[3]
evidence = args.out.resolve() if args.out else Path(tempfile.mkdtemp(prefix='teams-release-evidence-'))
if evidence.is_relative_to(repo) or (evidence.exists() and any(evidence.iterdir())):
    raise RuntimeError('Evidence must be a fresh external directory')
evidence.mkdir(parents=True, exist_ok=True)
commands = []


def run(name, command, cwd, timeout=120, env=None):
    target = evidence / (name + '.log')
    with target.open('wb') as output:
        process = subprocess.Popen(command, cwd=cwd, stdout=output, stderr=subprocess.STDOUT,
                                   start_new_session=True, env=env)
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            code = 124
    commands.append({'name': name, 'command': list(map(str, command)), 'cwd': str(cwd),
                     'exit': code, 'log': str(target), 'deadlineSeconds': timeout})
    (evidence / 'commands.json').write_text(json.dumps(commands, indent=2))
    if code:
        raise RuntimeError(f'{name} exited {code}; see {target}')
    return target


def revision(ref):
    return subprocess.check_output(['git', 'rev-parse', ref + '^{commit}'], cwd=repo,
                                   timeout=10, text=True).strip()


def extract(archive, directory):
    directory = directory.resolve()
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            path = (directory / member.name).resolve()
            if not path.is_relative_to(directory) or not (member.isfile() or member.isdir()):
                raise RuntimeError('Unsafe archive member')
        tar.extractall(directory)


source_paths = ['connectors/teams', 'connectors/shared/excerpt.py',
                'connectors/shared/localAppIcon.ts', 'connectors/shared/local-app-icon.js']
source, packer = revision(args.source), revision(args.packer or args.source)
metadata = {'source': source, 'packer': packer, 'worktree': args.worktree}
(evidence / 'revisions.json').write_text(json.dumps(metadata, indent=2))
with tempfile.TemporaryDirectory(prefix='teams-release-build-') as temporary:
    build = Path(temporary) / 'packer'
    build.mkdir()
    run('packer-export', ['git', 'archive', packer, '-o', str(evidence / 'packer.tar')], repo)
    extract(evidence / 'packer.tar', build)
    (evidence / 'packer.tar').unlink()
    shutil.rmtree(build / 'connectors/teams', ignore_errors=True)
    if args.worktree:
        names = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard',
                                         '--', *source_paths], cwd=repo).decode().split('\0')
        hashes = {}
        for name in sorted(set(filter(None, names))):
            path = repo / name
            if path.is_symlink():
                raise RuntimeError('Unexpected source symlink')
            if path.is_file():
                target = build / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, target)
                hashes[name] = hashlib.sha256(target.read_bytes()).hexdigest()
        (evidence / 'worktree-inputs.json').write_text(json.dumps(hashes, indent=2))
    else:
        # Older Teams releases predate the shared renderer.
        paths = subprocess.check_output(['git', 'ls-tree', '--name-only', source, '--', *source_paths],
                                        cwd=repo, text=True).splitlines()
        run('source-export', ['git', 'archive', source, *paths, '-o', str(evidence / 'source.tar')], repo)
        extract(evidence / 'source.tar', build)
        (evidence / 'source.tar').unlink()
    run('frozen-install', ['pnpm', 'install', '--frozen-lockfile'], build, 600)
    run('archive', ['bun', 'packaging/src/cli/build-connectors.ts', '--connectors', 'connectors/teams',
                    '--out', str(evidence / 'archive')], build)
    archives = list((evidence / 'archive').glob('teams-*.tar.gz'))
    if len(archives) != 1:
        raise RuntimeError('Expected exactly one Teams archive')
    archive = archives[0]
    metadata.update(archive=str(archive), sha256=hashlib.sha256(archive.read_bytes()).hexdigest())
    (evidence / 'revisions.json').write_text(json.dumps(metadata, indent=2))
    manifest = json.loads((build / 'connectors/teams/connector.json').read_text())
    [official] = json.loads((archive.parent / 'official-connectors.json').read_text())
    if (archive.parent / 'SHA256SUMS').read_text() != f"{metadata['sha256']}  {archive.name}\n":
        raise RuntimeError('Archive checksum mismatch')
    if official['name'] != 'teams' or official['version'] != manifest['version']:
        raise RuntimeError('Official connector metadata mismatch')
    expected = {'connector.json', manifest['entry']['path'], *manifest['files']}
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        if len(members) != len(expected) or any(not m.isfile() for m in members) or set(tar.getnames()) != expected:
            raise RuntimeError('Unexpected package inventory')
    installed = evidence / 'installed'
    installed.mkdir(mode=0o700)
    extract(archive, installed)
    home = Path(temporary) / 'host-home'
    home.mkdir(mode=0o700)
    isolated = {'HOME': str(home), 'PATH': os.environ['PATH'], 'TMPDIR': str(home),
                'EXANGELOS_HOME': str(home / 'exangelos'), 'XDG_DATA_HOME': str(home / 'data'),
                'XDG_CACHE_HOME': str(home / 'cache'), 'XDG_CONFIG_HOME': str(home / 'config')}
    try:
        run('lifecycle', ['bun', 'connectors/teams/test/ReleaseValidation.ts', str(installed),
                           str(evidence), sys.executable, official['digest']], build, 240, env=isolated)
        run('typecheck', ['pnpm', '--filter', '@exangelos/connector-teams', 'typecheck'], build)
        run('teams-tests', ['pnpm', '--filter', '@exangelos/connector-teams', 'test'], build)
        for directory in ['runtime', 'validation']:
            run('python-' + directory, [sys.executable, '-B', '-c',
                'import sys,unittest; sys.path[:0]=["runtime","validation"]; '
                f'suite=unittest.defaultTestLoader.discover("{directory}"); '
                'result=unittest.TextTestRunner(verbosity=1).run(suite); '
                'sys.exit(not result.wasSuccessful())'], build / 'connectors/teams')
        if hashlib.sha256(archive.read_bytes()).hexdigest() != metadata['sha256']:
            raise RuntimeError('Archive changed during installed checks')
    finally:
        shutil.rmtree(installed)
print(evidence)
