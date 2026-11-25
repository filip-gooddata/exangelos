"""Run on macOS with Bun and unpacked official Slack and Teams archive directories as arguments."""
import json
import os
from pathlib import Path
import shutil
import signal
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'slack/test'))
from archive_validation import Wire


def renderer_probe(bundle, mode):
    with tempfile.TemporaryDirectory() as directory:
        home = Path(directory)
        installed = home / 'connector'
        shutil.copytree(bundle, installed)
        script = installed / 'dist/local-app-icon.js'
        marker = home / 'renderer.pid'
        # Keep the packaged entry point and its real osascript child. Only the artwork source is synthetic.
        script.write_text("""
ObjC.import("Foundation")
ObjC.bindFunction("sigignore", ["int", ["int"]])
function run() {
    if ($.sigignore(15) !== 0) throw Error("sigignore failed")
    const id = $.NSProcessInfo.processInfo.processIdentifier
    $(String(id)).writeToFileAtomicallyEncodingError(MARKER, true, $.NSUTF8StringEncoding, null)
    delay(DELAY)
    return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII="
}
""".replace('MARKER', json.dumps(str(marker))).replace('DELAY', '4' if mode == 'delayed' else '30'))
        with Wire(installed, home) as wire:
            try:
                assert wire.call('Handshake', None)['protocolVersion'] == 1
                start = time.monotonic()
                request = wire.request('Icon', None)
                while not marker.exists():
                    assert time.monotonic() - start < 6, 'renderer did not start'
                    time.sleep(.02)
                pid = int(marker.read_text())
                deadline = start + 10
                if mode == 'interrupt':
                    deadline = min(deadline, time.monotonic() + 2)
                    wire.send(dict(_tag='Interrupt', requestId=request))
                reply = wire.receive(timeout=deadline - time.monotonic())
                assert reply['requestId'] == request
                if mode == 'interrupt':
                    assert reply['exit']['_tag'] == 'Failure', reply
                else:
                    expected = 'Served' if mode == 'delayed' else 'None'
                    assert reply['exit']['value']['_tag'] == expected
                while True:
                    assert time.monotonic() < deadline, 'renderer outlived request budget'
                    try:
                        os.kill(pid, 0)
                    except ProcessLookupError:
                        break
                    time.sleep(.02)
                print(bundle.name, mode, round(time.monotonic() - start, 2), flush=True)
            except BaseException:
                # Clean up even when testing an older bundle that strands its renderer.
                if marker.exists():
                    try:
                        os.kill(int(marker.read_text()), signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                raise


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit('Supply an unpacked Slack or Teams archive directory.')
    for archive_directory in sys.argv[1:]:
        for scenario in ('delayed', 'timeout', 'interrupt'):
            renderer_probe(Path(archive_directory), scenario)
