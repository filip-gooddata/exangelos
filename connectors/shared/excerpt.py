"""Render a bounded excerpt, hiding known inherited secrets before clipping."""
import os
import re


SENSITIVE_KEY = re.compile(r'token|key|secret|password|auth|cookie', re.I | re.ASCII)


def mask_secrets(text, *, omit=()):
    # Mark matches in the original text so overlapping values leave no fragments.
    hidden = None
    for key, value in os.environ.items():
        if not value or not SENSITIVE_KEY.search(key):
            continue
        at = text.find(value)
        while at != -1:
            if hidden is None:
                hidden = bytearray(len(text))
            hidden[at:at + len(value)] = b'\x01' * len(value)
            at = text.find(value, at + 1)
    if omit:
        chars = list(text)
        for index in omit:
            chars[index] = ''
    else:
        chars = text
    if hidden is not None:
        pieces = []
        start = 0
        for match in re.finditer(b'\x01+', hidden):
            pieces.extend((''.join(chars[start:match.start()]), '[redacted]'))
            start = match.end()
        return ''.join(pieces) + ''.join(chars[start:])
    return ''.join(chars) if omit else text


def finish_excerpt(text):
    text = mask_secrets(text)
    return ' '.join(''.join(c if c.isprintable() else ' ' for c in text).split())[:160]
