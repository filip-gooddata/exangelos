"""Membership decoding for the native properties.emotions cache representation."""


def members(node):
    properties = node.get('properties')
    if type(properties) is not dict:
        return None
    emotions = properties.get('emotions', [])
    if type(emotions) is not list or len(emotions) > 256:
        return None
    result = set()
    for emotion in emotions:
        if type(emotion) is not dict or type(emotion.get('key')) is not str or not emotion['key']:
            return None
        users = emotion.get('users')
        if type(users) is not list or len(users) > 500:
            return None
        for user in users:
            if type(user) is not dict or type(user.get('mri')) is not str or not user['mri']:
                return None
            member = (emotion['key'], user['mri'])
            if member in result or sum(len(v) for v in member) > 4096:
                return None
            result.add(member)
            if len(result) > 500:
                return None
    return sorted(result)
