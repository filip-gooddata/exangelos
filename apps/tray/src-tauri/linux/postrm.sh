#!/bin/sh
# Removes the xng alias that postinst.sh created.
set -e
case "$1" in
  remove|purge)
    if [ "$(readlink /usr/bin/xng 2>/dev/null)" = exangelos ]; then
      rm -f /usr/bin/xng
    fi
    ;;
esac
