"""Create a private persisted-cache selection from a literal message snippet."""

def main():
    import argparse
    import contextlib
    import getpass
    import json
    import logging
    import os
    from pathlib import Path
    import secrets
    import sys
    import warnings

    logging.disable(logging.CRITICAL)
    terminal = sys.stderr
    try:
        with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            import observation
            import scan
            import source

            parser = argparse.ArgumentParser()
            parser.add_argument('--output', required=True)
            parser.add_argument('--root', type=Path)
            args = parser.parse_args()
            if sys.stdin.isatty():
                with warnings.catch_warnings():
                    warnings.simplefilter('error', getpass.GetPassWarning)
                    snippet = getpass.getpass('Cached message snippet (hidden): ', stream=terminal)
            else:
                snippet = sys.stdin.buffer.read(source.MAX_INPUT + 1).decode('utf-8')
            if not snippet or len(snippet.encode('utf-8')) > source.MAX_INPUT:
                raise ValueError('input')
            root = args.root or Path.home() / 'Library/Application Support/Slack/IndexedDB'
            if root.is_symlink():
                raise ValueError('symlink')
            root = root.resolve(strict=True)
            before, epoch = source.inventory(root)
            matches = set()

            def collect(state, generation):
                identity = observation.scope(state)
                for conversation, messages in (state.get('messages') or {}).items():
                    for message in messages.values():
                        text = message.get('text') if isinstance(message, dict) else None
                        if isinstance(text, str) and snippet in text:
                            matches.add((*identity, conversation))

            result = scan.run(root, observe=collect)
            if result['external_rejections'] or result['files_changed'] or not result['current_unchanged'] or len(matches) != 1:
                raise ValueError('unavailable')
            workspace, owner, conversation = matches.pop()
            request = {'selection': {'workspace': workspace, 'owner': owner, 'conversations': [conversation]},
                       'key': secrets.token_hex(32)}
            if args.root is not None:
                request['root'] = str(root)
            source.acquire(request)
            after, after_epoch = source.inventory(root)
            if before != after or epoch != after_epoch:
                raise ValueError('mutation')
            fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(fd, 'w', encoding='utf-8') as handle:
                    os.fchmod(handle.fileno(), 0o600)
                    json.dump(request, handle, separators=(',', ':'))
                    handle.write('\n')
            except BaseException:
                os.unlink(args.output)
                raise
    except BaseException:
        terminal.write('Slack private selection unavailable.\n')
        return 1
    return 0


if __name__ == '__main__':
    import sys
    sys.exit(main())
