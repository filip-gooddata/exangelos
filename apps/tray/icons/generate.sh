#!/bin/sh
set -eu
cd "$(dirname "$0")"
icon=../../../assets/app-icon.svg
glyph=../../../assets/menu-bar-glyph.svg

python3 - "$glyph" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
view = re.search(r'viewBox="([^"]+)"', src).group(1)
x, y, w, h = (float(v) for v in view.split())
path = re.search(r"<path[^>]*/>", src, re.S).group(0)
r = w * 0.15
cx, cy = x + w - r, y + r
open("glyph-attention.svg", "w").write(
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}">\n'
    f'<defs><mask id="notch"><rect x="{x}" y="{y}" width="{w}" height="{h}" fill="white"/>'
    f'<circle cx="{cx}" cy="{cy}" r="{r * 1.45}" fill="black"/></mask></defs>\n'
    f'<g mask="url(#notch)">{path}</g>\n'
    f'<circle cx="{cx}" cy="{cy}" r="{r}"/>\n'
    "</svg>\n"
)
PY

rsvg-convert -w 36 -h 36 "$glyph" -o tray-quiet.png
rsvg-convert -w 36 -h 36 glyph-attention.svg -o tray-attention.png

rsvg-convert -w 32 -h 32 "$icon" -o 32x32.png
rsvg-convert -w 128 -h 128 "$icon" -o 128x128.png
rsvg-convert -w 256 -h 256 "$icon" -o 128x128@2x.png
rsvg-convert -w 512 -h 512 "$icon" -o icon.png

if command -v iconutil >/dev/null 2>&1; then
  set_dir=$(mktemp -d)/icon.iconset
  mkdir "$set_dir"
  for size in 16 32 128 256 512; do
    rsvg-convert -w "$size" -h "$size" "$icon" -o "$set_dir/icon_${size}x${size}.png"
    rsvg-convert -w $((size * 2)) -h $((size * 2)) "$icon" -o "$set_dir/icon_${size}x${size}@2x.png"
  done
  iconutil -c icns "$set_dir" -o icon.icns
  rm -rf "$(dirname "$set_dir")"
fi
