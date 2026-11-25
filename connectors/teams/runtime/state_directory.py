"""Locate Teams private state separately from replaceable connector bundles."""
import os
from pathlib import Path


def state_directory():
    home = os.environ.get('EXANGELOS_HOME')
    root = Path(home) if home else Path(os.environ.get('XDG_DATA_HOME') or Path.home() / '.local/share') / 'exangelos'
    if not root.is_absolute() or '..' in root.parts:
        raise ValueError('Invalid Teams state root')
    current = root / 'connector-state/teams'
    legacy = root / 'connectors/teams'
    if not current.exists() and not (legacy / 'connector.json').exists():
        if any((legacy / name).exists() for name in ('pin-key-v1.json', 'ledger.sqlite3')):
            return legacy
    return current
