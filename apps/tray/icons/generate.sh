#!/bin/sh
# Regenerates every PNG and the .icns in this directory from mark.svg.
# Needs rsvg-convert (Homebrew librsvg) and, for icon.icns, macOS iconutil.
set -eu
cd "$(dirname "$0")"

# "Needs you": the mark with a notch cut at the top right and a dot inside it.
python3 - <<'PY'
import re
src = open("mark.svg").read()
path = re.search(r"<path[^>]*/>", src, re.S).group(0)
open("mark-attention.svg", "w").write(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">\n'
    '<defs><mask id="notch"><rect width="1024" height="1024" fill="white"/>'
    '<circle cx="850" cy="174" r="220" fill="black"/></mask></defs>\n'
    f'<g mask="url(#notch)">{path}</g>\n'
    '<circle cx="850" cy="174" r="150"/>\n'
    "</svg>\n"
)
PY

# Menu bar template images: black glyph on transparent, 36 px for an 18 pt slot.
rsvg-convert -w 36 -h 36 mark.svg -o tray-quiet.png
rsvg-convert -w 36 -h 36 mark-attention.svg -o tray-attention.png

# App icons.
rsvg-convert -w 32 -h 32 mark.svg -o 32x32.png
rsvg-convert -w 128 -h 128 mark.svg -o 128x128.png
rsvg-convert -w 256 -h 256 mark.svg -o 128x128@2x.png
rsvg-convert -w 512 -h 512 mark.svg -o icon.png

if command -v iconutil >/dev/null 2>&1; then
  set_dir=$(mktemp -d)/icon.iconset
  mkdir "$set_dir"
  for size in 16 32 128 256 512; do
    rsvg-convert -w "$size" -h "$size" mark.svg -o "$set_dir/icon_${size}x${size}.png"
    rsvg-convert -w $((size * 2)) -h $((size * 2)) mark.svg -o "$set_dir/icon_${size}x${size}@2x.png"
  done
  iconutil -c icns "$set_dir" -o icon.icns
  rm -rf "$(dirname "$set_dir")"
fi
