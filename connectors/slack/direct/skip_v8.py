"""Structural skipping extensions for persisted Redux containers."""
import field_v8
class Reader(field_v8._Reader):
    def value(self, depth, mode):
        start = self.pos
        tag = self.tag()
        if tag in (ord("'"), ord(';')):
            self.node(depth)
            self.objects += 1
            end = ord(',') if tag == ord("'") else ord(':')
            count = 0
            while True:
                pos = self.pos
                if self.tag() == end:
                    break
                self.pos = pos
                self.value(depth + 1, 'skip')
                count += 1
            if self.uint() != count or (tag == ord(';') and count % 2):
                raise ValueError('count')
            return None
        if tag == ord('a'):
            self.node(depth)
            self.objects += 1
            length = self.uint()
            self.properties(depth, ord('@'), None)
            if self.uint() != length:
                raise ValueError('array_length')
            return None
        self.pos = start
        return super().value(depth, mode)
