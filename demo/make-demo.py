"""Build the demo files from Quaternius' Universal Animation Library (CC0): a correct mannequin, a deliberately broken one
(head skin moved onto the right upper arm, left forearm skin onto the right forearm) and a few moves.

  Blender -b --factory-startup -P demo/make-demo.py -- <UAL glb> demo/ model|broken|moves
"""
import bpy, os, sys

argv = sys.argv[sys.argv.index('--') + 1:]
src, outdir, mode = argv[0], argv[1], argv[2]
KEEP = ['Idle_Loop', 'Walk_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop', 'Jump_Start', 'Crouch_Fwd_Loop', 'Punch_Jab', 'Death01']

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
rig = next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE')
body = next(o for o in bpy.context.scene.objects if o.type == 'MESH' and o.name == 'Mannequin')
for o in list(bpy.context.scene.objects):
    if o is not rig and (mode == 'moves' or o is not body):
        bpy.data.objects.remove(o, do_unlink=True)

bpy.ops.object.select_all(action='DESELECT')
rig.select_set(True)
if mode == 'moves':
    for a in list(bpy.data.actions):
        if a.name not in KEEP:
            bpy.data.actions.remove(a)
    rig.animation_data_create()
    rig.animation_data.action = None
    for t in list(rig.animation_data.nla_tracks):
        rig.animation_data.nla_tracks.remove(t)
    for a in bpy.data.actions:
        track = rig.animation_data.nla_tracks.new()
        track.name = a.name
        track.strips.new(a.name, int(a.frame_range[0]), a)
        track.mute = True
    bpy.ops.export_scene.gltf(filepath=os.path.join(outdir, 'moves.glb'), export_format='GLB', use_selection=True,
                              export_animations=True, export_animation_mode='NLA_TRACKS', export_force_sampling=True)
else:
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)
    if rig.animation_data:
        rig.animation_data_clear()
    if mode == 'broken':
        head, arm = body.vertex_groups['DEF-head'], body.vertex_groups['DEF-upper_arm.R']
        moved = 0
        for v in body.data.vertices:
            for g in v.groups:
                if g.group == head.index and g.weight > 0:
                    arm.add([v.index], g.weight, 'ADD')
                    head.add([v.index], 0.0, 'REPLACE')
                    moved += 1
        print('DEMO moved', moved, 'head vertices onto DEF-upper_arm.R')
        # and the left forearm's skin follows the right forearm: the arm stretches across the body
        fl, fr = body.vertex_groups['DEF-forearm.L'], body.vertex_groups['DEF-forearm.R']
        moved = 0
        for v in body.data.vertices:
            for g in v.groups:
                if g.group == fl.index and g.weight > 0:
                    fr.add([v.index], g.weight, 'ADD')
                    fl.add([v.index], 0.0, 'REPLACE')
                    moved += 1
        print('DEMO moved', moved, 'left forearm vertices onto DEF-forearm.R')
    body.select_set(True)
    name = 'mannequin-broken.glb' if mode == 'broken' else 'mannequin.glb'
    bpy.ops.export_scene.gltf(filepath=os.path.join(outdir, name), export_format='GLB', use_selection=True,
                              export_skins=True, export_animations=False)
print('DEMO wrote', mode)
