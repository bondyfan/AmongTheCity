#!/bin/bash
# ---- build-people.sh: sources to public/assets/people/ --------------------------
# Run by hand after scripts/people/fetch-rocketbox.sh, never as part of a build.
# Needs Blender (headless), Python 3 with Pillow, and node.
#   1. every person of scripts/people/people.json: FBX -> avatars/<id>.glb
#   2. every animation that was fetched: FBX -> a clip .glb (kept with the sources)
#   3. the clips baked into one file: clips.bin
#   4. the atlases, the far atlas and manifest.json
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
SRC="${ATC_PEOPLE_SRC:-$HOME/Documents/html/atc-character-sources}"
OUT="$REPO/public/assets/people"
BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
mkdir -p "$OUT/avatars" "$SRC/out/meta" "$SRC/out/anims"
step="${1:-all}"

if [ "$step" = all ] || [ "$step" = avatars ]; then
  python3 -c "import json,sys; [print(a['id'], a['name']) for a in json.load(open(sys.argv[1]))['avatars']]" "$HERE/people.json" |
  while read -r id name; do
    fbx="$(ls "$SRC"/rocketbox/Assets/Avatars/*/"$name"/Export/"$name".fbx 2>/dev/null | head -1)"
    [ -n "$fbx" ] || { echo "no source for $name"; continue; }
    [ -s "$OUT/avatars/$id.glb" ] && [ -s "$SRC/out/meta/$id.json" ] && continue
    nice -n 10 "$BLENDER" -b --python "$HERE/convert-rocketbox.py" -- avatar "$fbx" "$OUT/avatars/$id.glb" "$SRC/out/meta/$id.json" 2>&1 | grep -E "ATC_|Traceback|Error" | sed "s/^/$id /" || true
  done
fi
if [ "$step" = all ] || [ "$step" = anims ]; then
  for fbx in "$SRC"/rocketbox/Assets/Animations/*/*.max.fbx; do
    name="$(basename "$fbx" .max.fbx)"; name="${name// /_}"
    [ -s "$SRC/out/anims/$name.glb" ] && continue
    nice -n 10 "$BLENDER" -b --python "$HERE/convert-rocketbox.py" -- anim "$fbx" "$SRC/out/anims/$name.glb" 2>&1 | grep -E "ATC_ANIM|Traceback|Error" | sed "s/^/$name /" || true
  done
fi
if [ "$step" = all ] || [ "$step" = clips ]; then
  nice -n 10 node "$HERE/bake-clips.mjs" "$SRC/out/anims" "$OUT/clips.bin" "$HERE/people.json"
fi
if [ "$step" = all ] || [ "$step" = atlas ]; then
  nice -n 10 python3 "$HERE/build-atlas.py" "$SRC/rocketbox/Assets/Avatars" "$OUT" "$HERE/people.json" "$SRC/out/meta"
fi
du -sh "$OUT" | awk '{print "people bank: " $1}'
