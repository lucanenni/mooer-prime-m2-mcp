#!/bin/sh
# Exits non-zero when the copied protocol layer differs from the sibling web editor repo.
SRC="${1:-../mooer-prime-m2-web}"
[ -d "$SRC/src/protocol" ] || { echo "No web repo at $SRC, skipping."; exit 0; }
status=0
for f in frame device models catalog modelNames cloudPreset loopFile nam; do
  cmp -s "$SRC/src/protocol/$f.ts" "src/protocol/$f.ts" || { echo "differs: src/protocol/$f.ts"; status=1; }
done
cmp -s "$SRC/src/demo/fakePedal.ts" src/demo/fakePedal.ts || { echo "differs: src/demo/fakePedal.ts"; status=1; }
[ $status -eq 0 ] && echo "Protocol layer in sync."
exit $status
