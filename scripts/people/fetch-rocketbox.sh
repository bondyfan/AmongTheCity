#!/bin/bash
# ---- fetch-rocketbox.sh: the source files of the people bank -------------------
# Microsoft Rocketbox avatars and animations (MIT licence, (c) 2020 Microsoft,
# https://github.com/microsoft/Microsoft-Rocketbox). Run by hand, and only with
# the owner's yes: it downloads up to 2 GB. The files land OUTSIDE the repo;
# scripts/people/convert-rocketbox.py turns them into public/assets/people/.
#
#   fetch-rocketbox.sh previews           every avatar's preview picture (about 50 MB)
#   fetch-rocketbox.sh avatars A B ...    the FBX and colour textures of the named avatars
#   fetch-rocketbox.sh anims  a b ...     the named animation clips (without .max.fbx)
#
# Needs the repository's file list once (one API call, kept beside the files).
set -euo pipefail
OUT="${ATC_PEOPLE_SRC:-$HOME/Documents/html/atc-character-sources}/rocketbox"
RAW="https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/master"
mkdir -p "$OUT"
TREE="$OUT/tree.json"
[ -s "$TREE" ] || curl -fsSL "https://api.github.com/repos/microsoft/Microsoft-Rocketbox/git/trees/master?recursive=1" -o "$TREE"

# print the repo paths this run wants, one a line
list() {
  python3 - "$TREE" "$@" <<'PY'
import json, re, sys
tree, mode, names = sys.argv[1], sys.argv[2], set(sys.argv[3:])
for e in json.load(open(tree))['tree']:
    p = e['path']
    if e['type'] != 'blob':
        continue
    parts = p.split('/')
    if mode == 'previews':
        if p.startswith('Assets/Avatars/') and len(parts) == 5 and p.endswith('.png'):
            print(p)
    elif mode == 'avatars':
        if not p.startswith('Assets/Avatars/') or len(parts) < 5 or parts[3] not in names:
            continue
        f = parts[-1]
        if (f.endswith('.fbx') and '_facial' not in f) or f.endswith('.png') or re.search(r'_color(_[a-z]+)?\.tga$', f):
            print(p)
    elif mode == 'anims':
        if p.startswith('Assets/Animations/') and parts[-1].replace('.max.fbx', '') in names:
            print(p)
PY
}

mode="${1:-}"; shift || true
case "$mode" in previews|avatars|anims) ;; *) echo "usage: $0 previews | avatars NAME... | anims NAME..."; exit 2 ;; esac
n=0
list "$mode" "$@" | while IFS= read -r path; do
  dest="$OUT/$path"
  [ -s "$dest" ] && continue
  mkdir -p "$(dirname "$dest")"
  # spaces in a few animation names: encode them for the URL only
  curl -fsSL --retry 3 "$RAW/${path// /%20}" -o "$dest.part" && mv "$dest.part" "$dest"
  n=$((n + 1)); echo "$path"
done
du -sh "$OUT" | awk '{print "sources now: " $1}'
