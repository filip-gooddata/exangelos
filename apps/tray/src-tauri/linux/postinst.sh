#!/bin/sh
# Puts the xng alias next to /usr/bin/exangelos unless another command already owns the name.
set -e
if [ ! -e /usr/bin/xng ] || [ "$(readlink /usr/bin/xng)" = exangelos ]; then
  ln -sf exangelos /usr/bin/xng
fi
