#!/bin/sh
# Re-copies the protocol layer from the sibling web editor repo (single source of truth).
set -e
SRC="${1:-../mooer-prime-m2-web}"
for f in frame device models catalog modelNames cloudPreset loopFile nam; do cp "$SRC/src/protocol/$f.ts" src/protocol/; done
cp "$SRC/src/demo/fakePedal.ts" src/demo/
