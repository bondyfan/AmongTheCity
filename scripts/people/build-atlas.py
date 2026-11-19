# ---- build-atlas.py: one texture per person, and one for everybody far away ------
#
# Run by hand with the system Python (needs Pillow), never part of a build:
#
#   python3 scripts/people/build-atlas.py <rocketbox Assets/Avatars dir> <out dir> scripts/people/people.json <meta dir>
#
# A Rocketbox person has a body, a head and an alpha-cut hair texture, each
# 2048 square. The game draws a person in ONE call, so the three are laid into
# one atlas (the UVs are moved to match by convert-rocketbox.py: keep ATLAS in
# step with that file):
#
#   <out>/atlas/<id>.webp   1792 x 1280: body 1024, head 768, hair 512, extras 256
#   <out>/far.webp          every person's atlas at 224 x 160, in one grid: what
#                           a body sixty metres away is drawn with, and what a
#                           near one wears until its own atlas has arrived
#   <out>/manifest.json     scripts/people/people.json with, per person built, the
#                           far tile's place and a few colours read off the
#                           textures (skin, hair, top, bottom)

import glob
import json
import os
import sys

from PIL import Image

ATLAS = {"w": 1792, "h": 1280, "body": (0, 0, 1024, 1024), "head": (1024, 0, 768, 768), "hair": (1024, 768, 512, 512),
         "ex1": (1536, 768, 256, 256), "ex2": (1536, 1024, 256, 256)}
TILE = (224, 160)
COLS = 8

src, out, people = sys.argv[1], sys.argv[2], sys.argv[3]
cat = json.load(open(people))["avatars"]
os.makedirs(os.path.join(out, "atlas"), exist_ok=True)


def find(folder, *names):
    for s in names:
        hit = sorted(glob.glob(os.path.join(folder, "Textures", s)))
        if hit:
            return hit[0]
    return None


def mean(im, box):
    r = im.crop(box).convert("RGB").resize((1, 1), Image.BOX).getpixel((0, 0))
    return (r[0] << 16) | (r[1] << 8) | r[2]


def hair_tile(path, size):
    im = Image.open(path).convert("RGBA").resize(size, Image.LANCZOS)
    # the colour under a transparent texel still bleeds into its neighbours when
    # the texture is filtered: give it the hair's own average instead of black
    px = im.resize((1, 1), Image.BOX).getpixel((0, 0))
    a = max(1, px[3])
    avg = tuple(min(255, int(c * 255 / a)) for c in px[:3])
    base = Image.new("RGBA", size, avg + (0,))
    base.paste(im, (0, 0), im.split()[3].point(lambda v: 255 if v > 8 else 0))
    base.putalpha(im.split()[3])
    return base, (avg[0] << 16) | (avg[1] << 8) | avg[2]


info = {}
tiles = []
meta_dir = sys.argv[4] if len(sys.argv) > 4 else None
for e in cat:
    folder = glob.glob(os.path.join(src, "*", e["name"]))
    meta = os.path.join(meta_dir, e["id"] + ".json") if meta_dir else None
    if not folder or not meta or not os.path.exists(meta):
        continue
    folder = folder[0]
    atlas = Image.new("RGBA", (ATLAS["w"], ATLAS["h"]), (0, 0, 0, 0))
    col = {}
    # the converter wrote down which material went to which tile; a material
    # `m156_body` is painted by `m156_body_color.tga` (or `..._color_blue.tga`)
    for m in json.load(open(meta))["materials"]:
        part, x, y, w, h = m["part"], *ATLAS[m["part"]]
        p = find(folder, m["name"] + "_color.tga", m["name"] + "_color_*.tga")
        if not p:
            print("   no texture for", m["name"]); continue
        im = Image.open(p)
        if part == "hair":
            t, _ = hair_tile(p, (w, h))
            atlas.paste(t, (x, y))
        elif im.mode == "RGBA" and part.startswith("ex"):
            atlas.paste(im.resize((w, h), Image.LANCZOS), (x, y))          # glasses: the alpha is the lens
        else:
            im = im.convert("RGB")
            atlas.paste(im.resize((w, h), Image.LANCZOS).convert("RGBA"), (x, y))
            if part == "body":
                s = im.size[0] / 2048
                col["top"] = mean(im, tuple(int(v * s) for v in (900, 500, 1150, 800)))
                col["bottom"] = mean(im, tuple(int(v * s) for v in (150, 1500, 400, 1900)))
            if part == "head":
                s = im.size[0] / 2048
                col["skin"] = mean(im, tuple(int(v * s) for v in (900, 620, 1150, 760)))
                col["hair"] = mean(im, tuple(int(v * s) for v in (380, 150, 620, 330)))
    atlas.save(os.path.join(out, "atlas", e["id"] + ".webp"), quality=84, alpha_quality=92, method=6)
    i = len(tiles)
    tiles.append(atlas.resize(TILE, Image.LANCZOS))
    info[e["id"]] = {"tile": [(i % COLS) * TILE[0], (i // COLS) * TILE[1], TILE[0], TILE[1]], **col}
    print(e["id"], e["name"], os.path.getsize(os.path.join(out, "atlas", e["id"] + ".webp")) // 1024, "kB")

rows = (len(tiles) + COLS - 1) // COLS
far = Image.new("RGBA", (COLS * TILE[0], max(1, rows) * TILE[1]), (0, 0, 0, 0))
for i, t in enumerate(tiles):
    far.paste(t, ((i % COLS) * TILE[0], (i // COLS) * TILE[1]))
far.save(os.path.join(out, "far.webp"), quality=86, alpha_quality=92, method=6)
# ---- the manifest the game reads: the catalogue, with what was actually built ----
doc = json.load(open(people))
avatars = []
for e in doc["avatars"]:
    if e["id"] not in info or not os.path.exists(os.path.join(out, "avatars", e["id"] + ".glb")):
        continue
    avatars.append({**{k: v for k, v in e.items() if k != "name"}, "file": "avatars/" + e["id"] + ".glb",
                    "atlas": "atlas/" + e["id"] + ".webp", **info[e["id"]]})
doc["avatars"] = avatars
doc["far"] = {"file": "far.webp", "w": far.size[0], "h": far.size[1]}
if os.path.exists(os.path.join(out, "clips.bin")):
    doc["clipFile"] = "clips.bin"
else:
    doc["anims"] = [{"file": "anims/" + os.path.basename(f), "name": os.path.basename(f)[:-4]}
                    for f in sorted(glob.glob(os.path.join(out, "anims", "*.glb")))]
json.dump(doc, open(os.path.join(out, "manifest.json"), "w"), ensure_ascii=False, separators=(",", ":"))
print("manifest:", len(avatars), "people")
print("far atlas", far.size, os.path.getsize(os.path.join(out, "far.webp")) // 1024, "kB")
