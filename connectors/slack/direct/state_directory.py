"""Locate private state outside the host's connector installation tree."""
import os
from pathlib import Path


def state_directory():
    data = os.environ.get('EXANGELOS_HOME')
    base = Path(data) if data else Path(os.environ.get('XDG_DATA_HOME') or Path.home() / '.local/share') / 'exangelos'
    current = base / 'connector-state/slack'
    legacy = base / 'connectors/slack'
    if not current.exists() and not (legacy / 'connector.json').exists():
        if any((legacy / name).exists() for name in ('setup.json', 'ledger.sqlite3')):
            return legacy
    return current
