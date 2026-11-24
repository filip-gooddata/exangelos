"""Exercise the macOS renderer using generated app bundles and a synthetic app registry."""
import json
from pathlib import Path
import plistlib
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def synthetic_icns():
    row = bytes([0]) + bytes([255, 0, 0, 128]) * 128
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 128, 128, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(row * 128)) + chunk(b"IEND", b""))
    return b"icns" + struct.pack(">I", 16 + len(png)) + b"ic07" + struct.pack(">I", 8 + len(png)) + png


@unittest.skipUnless(sys.platform == "darwin", "requires AppKit")
class InstalledIconTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def bundle(self, bundle_id, name):
        contents = self.root / bundle_id / "Contents"
        resources = contents / "Resources"
        resources.mkdir(parents=True)
        (contents / "Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": bundle_id, "CFBundleIconFile": name,
        }))
        return resources

    def render(self, *ids):
        script = Path(__file__).with_name("local-app-icon.js").read_text() + """
function run([root, ...ids]) {
  const visited = []
  const encoded = installedIcon(ids, id => {
    visited.push(id)
    return $.NSURL.fileURLWithPath(root + "/" + id)
  })
  if (!encoded) return JSON.stringify({visited})
  const png = $.NSData.alloc.initWithBase64EncodedStringOptions(encoded, 0)
  const bitmap = $.NSBitmapImageRep.imageRepWithData(png)
  const alpha = Math.round(255 * bitmap.colorAtXY(64, 64).alphaComponent)
  return JSON.stringify({visited, width: Number(bitmap.pixelsWide), height: Number(bitmap.pixelsHigh), alpha})
}
"""
        result = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", "-e", script, str(self.root), *ids],
                                capture_output=True, text=True, check=True)
        return json.loads(result.stdout)

    def test_preference_and_fallback_preserve_alpha(self):
        modern, classic = "com.microsoft.teams2", "com.microsoft.teams"
        image = synthetic_icns()
        (self.bundle(classic, "Classic.icns") / "Classic.icns").write_bytes(image)
        expected = {"visited": [modern, classic], "width": 128, "height": 128, "alpha": 128}
        self.assertEqual(self.render(modern, classic), expected)
        (self.bundle(modern, "Modern") / "Modern.icns").write_bytes(image)
        self.assertEqual(self.render(modern, classic), dict(expected, visited=[modern]))

    def test_missing_broken_and_escaping_resource(self):
        self.assertEqual(self.render("missing"), {"visited": ["missing"]})
        icon = self.bundle("test.fixture", "Test.icns") / "Test.icns"
        icon.write_bytes(b"broken icon")
        self.assertEqual(self.render("test.fixture"), {"visited": ["test.fixture"]})
        icon.unlink()
        outside = self.root / "outside.icns"
        outside.write_bytes(synthetic_icns())
        icon.symlink_to(outside)
        self.assertEqual(self.render("test.fixture"), {"visited": ["test.fixture"]})


if __name__ == "__main__":
    unittest.main()
