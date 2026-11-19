# ---- convert-rocketbox.py: Rocketbox FBX to the game's people bank ---------------
#
# Run inside Blender, headless, by hand (it is never part of a build):
#
#   Blender -b --python scripts/people/convert-rocketbox.py -- avatar <in.fbx> <out.glb> <meta.json>
#   Blender -b --python scripts/people/convert-rocketbox.py -- anim   <in.fbx> <out.glb>
#
# AVATAR. A Rocketbox person is one mesh with three materials (body, head, the
# alpha-cut hair cards) on an 80-bone Biped. Out comes a .glb WITHOUT images:
#   near_body, near_head, near_hair   the full mesh, split by material so the
#                                     game can draw a head on another body;
#                                     UVs already moved into the atlas layout
#                                     of scripts/people/build-atlas.py
#   far                               the same person at about 1 300 triangles
# on a skeleton of 52 bones: the 28 face bones are folded into the head.
#
# ANIM. One clip, the skeleton only, sampled every other frame, with the
# Biped's root (the armature object itself, which carries the travel and the
# turn of the hips) exported as a node of its own.
#
# The atlas layout is shared with build-atlas.py: keep ATLAS in step.

import sys
import bpy

ATLAS = {"w": 1792, "h": 1280, "body": (0, 0, 1024, 1024), "head": (1024, 0, 768, 768), "hair": (1024, 768, 512, 512),
         "ex1": (1536, 768, 256, 256), "ex2": (1536, 1024, 256, 256)}
FAR_TRIS = 1300
KEEP_FACE = False

argv = sys.argv[sys.argv.index("--") + 1:]
mode, src, dst = argv[0], argv[1], argv[2]
meta_path = argv[3] if len(argv) > 3 else None

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.fbx_import(filepath=src)
arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
# the children were rigged on a second Biped: one name for every skeleton, so one set of clips fits all
for b in arm.data.bones:
    if b.name.startswith("Bip02"):
        b.name = "Bip01" + b.name[5:]


def is_face(name):
    n = name.replace("Bip01 ", "")
    body = ("Pelvis", "Spine", "Neck", "Head", "Clavicle", "UpperArm", "Forearm", "Hand", "Finger", "Thigh", "Calf", "Foot", "Toe")
    return not any(k in n for k in body)


_extras = []


def part_of(mat_name):
    """body, head, hair, or one of the two spare atlas tiles for anything else
    (a belt of equipment, a holstered pistol, glasses, a stethoscope)."""
    n = mat_name.lower().split(".")[0]
    if n.endswith("_body"):
        return "body"
    if n.endswith("_head"):
        return "head"
    if n.endswith("_opacity") and "glasses" not in n:
        return "hair"
    if n not in _extras:
        _extras.append(n)
    return "ex1" if _extras.index(n) == 0 else "ex2"


def select_only(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def export(objs, with_anim):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(
        filepath=dst, export_format="GLB", use_selection=True, export_yup=True,
        export_image_format="NONE", export_materials="EXPORT" if not with_anim else "NONE",
        export_skins=True, export_animations=with_anim, export_morph=False,
        export_normals=True, export_texcoords=True, export_tangents=False, export_cameras=False, export_lights=False,
        **({"export_frame_step": 2, "export_force_sampling": True, "export_optimize_animation_size": True,
            "export_animation_mode": "ACTIVE_ACTIONS", "export_anim_single_armature": True} if with_anim else {}),
    )


if mode == "avatar":
    mesh = next(o for o in bpy.data.objects if o.type == "MESH")
    # the pose the file was saved in is the bind pose; an avatar needs no clip
    arm.animation_data_clear()
    # ---- fold the face bones into the head ----
    if not KEEP_FACE:
        head_vg = mesh.vertex_groups.get("Bip01 Head") or mesh.vertex_groups.new(name="Bip01 Head")
        face = [b.name for b in arm.data.bones if is_face(b.name)]
        for name in face:
            vg = mesh.vertex_groups.get(name)
            if vg is None:
                continue
            for v in mesh.data.vertices:
                for g in v.groups:
                    if g.group == vg.index and g.weight > 0:
                        head_vg.add([v.index], g.weight, "ADD")
            mesh.vertex_groups.remove(vg)
        select_only(arm)
        bpy.ops.object.mode_set(mode="EDIT")
        for name in face:
            eb = arm.data.edit_bones.get(name)
            if eb is not None:
                arm.data.edit_bones.remove(eb)
        bpy.ops.object.mode_set(mode="OBJECT")
    # ---- UVs into the atlas, material slot by material slot ----
    uv = mesh.data.uv_layers[0].data
    W, H = ATLAS["w"], ATLAS["h"]
    parts = [part_of(s.material.name) if s.material else "body" for s in mesh.material_slots]
    if meta_path:
        # which texture goes in which tile: build-atlas.py reads this
        import json
        json.dump({"materials": [{"name": s.material.name.split(".")[0] if s.material else "", "part": p}
                                 for s, p in zip(mesh.material_slots, parts)]}, open(meta_path, "w"))
    for poly in mesh.data.polygons:
        x, y, w, h = ATLAS[parts[poly.material_index]]
        for li in poly.loop_indices:
            u, v = uv[li].uv
            # image rows run top-down, v runs bottom-up
            uv[li].uv = ((x + u * w) / W, 1.0 - (y + (1.0 - v) * h) / H)
    # ---- the far body: one piece, coarse ----
    select_only(mesh)
    bpy.ops.object.duplicate()
    far = bpy.context.view_layer.objects.active
    far.name = "far"
    far.data.name = "far"
    tris = sum(len(p.vertices) - 2 for p in far.data.polygons)
    dec = far.modifiers.new("dec", "DECIMATE")
    dec.ratio = min(1.0, FAR_TRIS / max(1, tris))
    dec.use_collapse_triangulate = True
    # the armature modifier must stay last, so the decimation is applied below it
    bpy.ops.object.modifier_move_to_index(modifier="dec", index=0)
    bpy.ops.object.modifier_apply(modifier="dec")
    one = bpy.data.materials.new("far")
    far.data.materials.clear()
    far.data.materials.append(one)
    # ---- the near body: a mesh per part ----
    select_only(mesh)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.separate(type="MATERIAL")
    bpy.ops.object.mode_set(mode="OBJECT")
    near = [o for o in bpy.data.objects if o.type == "MESH" and o is not far]
    for o in near:
        p = part_of(o.material_slots[0].material.name) if o.material_slots and o.material_slots[0].material else "body"
        # belts, holsters and glasses are drawn with the body
        p = "body" if p.startswith("ex") else p
        o.name = "near_" + p
        o.data.name = "near_" + p
    stats = {o.name: sum(len(p.vertices) - 2 for p in o.data.polygons) for o in near + [far]}
    print("ATC_STATS", stats, "bones", len(arm.data.bones), "materials", [s.material.name for s in mesh.material_slots if s.material])
    export([arm] + near + [far], False)

elif mode == "anim":
    act = arm.animation_data.action if arm.animation_data else None
    print("ATC_ANIM", act.name if act else None, tuple(act.frame_range) if act else None)
    # only the bones a body has: the helpers and the face are dead weight in a clip
    select_only(arm)
    bpy.ops.object.mode_set(mode="EDIT")
    for eb in list(arm.data.edit_bones):
        if is_face(eb.name) or "Xtra" in eb.name or "Footsteps" in eb.name:
            arm.data.edit_bones.remove(eb)
    bpy.ops.object.mode_set(mode="OBJECT")
    print("ATC_BONES", len(arm.data.bones))
    export([arm], True)
