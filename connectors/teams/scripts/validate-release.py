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
parser.add_argument('--packer', default='75e07311b13bdc1569f7732b89efe682f7406d9b')
parser.add_argument('--out', type=Path)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[3]
evidence = args.out.resolve() if args.out else Path(tempfile.mkdtemp(prefix='teams-release-evidence-'))
if evidence.is_relative_to(repo) or (evidence.exists() and any(evidence.iterdir())):
    raise RuntimeError('Evidence must be a fresh external directory')
evidence.mkdir(parents=True, exist_ok=True)
commands = []


def run(name, command, cwd, timeout=120):
    target = evidence / (name + '.log')
    with target.open('wb') as output:
        process = subprocess.Popen(command, cwd=cwd, stdout=output, stderr=subprocess.STDOUT,
                                   start_new_session=True)
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


source, packer = revision(args.source), revision(args.packer)
metadata = {'source': source, 'packer': packer, 'harness': revision('HEAD')}
(evidence / 'revisions.json').write_text(json.dumps(metadata, indent=2))
with tempfile.TemporaryDirectory(prefix='teams-release-build-') as temporary:
    build = Path(temporary) / 'packer'
    build.mkdir()
    run('packer-export', ['git', 'archive', packer, '-o', str(evidence / 'packer.tar')], repo)
    extract(evidence / 'packer.tar', build)
    (evidence / 'packer.tar').unlink()
    shutil.rmtree(build / 'connectors/teams', ignore_errors=True)
    run('source-export', ['git', 'archive', source, 'connectors/teams', '-o', str(evidence / 'source.tar')], repo)
    extract(evidence / 'source.tar', build)
    (evidence / 'source.tar').unlink()
    run('frozen-install', ['pnpm', 'install', '--frozen-lockfile'], build, 600)
    run('source-frozen-install', ['pnpm', 'install', '--frozen-lockfile'], repo, 600)
    for name, directory in [('packer', build), ('source', repo)]:
        log = run(name + '-effect', ['bun', '-e', 'console.log(require("effect/package.json").version)'], directory / 'connectors/teams')
        if log.read_text().strip() != '4.1.4':
            raise RuntimeError('Expected installed Effect 4.1.4')
    run('archive', ['bun', 'packaging/src/cli/build-connectors.ts', '--connectors', 'connectors/teams',
                    '--out', str(evidence / 'archive')], build)
    archives = list((evidence / 'archive').glob('teams-*.tar.gz'))
    if len(archives) != 1:
        raise RuntimeError('Expected exactly one Teams archive')
    archive = archives[0]
    metadata.update(archive=str(archive), sha256=hashlib.sha256(archive.read_bytes()).hexdigest())
    (evidence / 'revisions.json').write_text(json.dumps(metadata, indent=2))
    installed = evidence / 'installed'
    installed.mkdir(mode=0o700)
    extract(archive, installed)
    try:
        run('lifecycle', ['bun', 'connectors/teams/test/ReleaseValidation.ts', str(installed),
                           str(evidence), sys.executable], repo, 180)
        run('typecheck', ['pnpm', '--filter', '@exangelos/connector-teams', 'typecheck'], repo)
        run('teams-tests', ['pnpm', '--filter', '@exangelos/connector-teams', 'test'], repo)
        for directory in ['runtime', 'validation']:
            run('python-' + directory, [sys.executable, '-B', '-c',
                'import sys,unittest; sys.path[:0]=["runtime","validation"]; '
                f'suite=unittest.defaultTestLoader.discover("{directory}"); '
                'result=unittest.TextTestRunner(verbosity=1).run(suite); '
                'sys.exit(not result.wasSuccessful())'], repo / 'connectors/teams')
    finally:
        shutil.rmtree(installed)
print(evidence)
