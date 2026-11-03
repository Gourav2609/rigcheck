---
name: rigcheck
description: Check rigged three.js characters (GLB/GLTF) for broken skinning, smeared or missing body parts and bad poses after retargeting animations (e.g. Mixamo) onto them, then have a fresh reviewer agent inspect close-ups. Use when the user adds or converts a character model, moves animations onto a model, or says a character "looks off", "stretched", "broken", "folded", or asks for a playtest of characters.
---

# rigcheck: measure, then look with fresh eyes

## 1. Run the measurements

```bash
npx rigcheck --model <character.glb> [--model <more.glb>] [--anims <animation-library.glb>] --out rigcheck-report
```

- It opens a browser tab; WebGL is needed for the close-ups. If you drive a browser yourself, use `--no-open` and open
  the printed URL in a **visible** browser (headless browsers without a GPU render blank close-ups).
- Exit code 0 = all OK, 1 = something failed. Read the printed summary, then `rigcheck-report/report.json`.

## 2. Fresh-eyes review (do not skip, even if everything is OK)

Numbers miss things that look wrong but aren't geometrically broken. Spawn a **separate reviewer agent** that has NOT
seen your notes or the numbers, and give it only:

- the folder `rigcheck-report/shots/` (rest pose from four sides, and each clip at its worst frame, front and side,
  all on a magenta background), and
- this checklist, to answer per character and per clip:
  1. **Head and face**: present, upright where it should be, not folded into the chest, not flattened, face not dark or blank.
  2. **Hands and feet**: present, sensible size, fingers not exploded, feet on the ground plane.
  3. **Limbs**: no arm or leg bent the wrong way, no limb through the body, no twisted wrists or ankles.
  4. **Clothes and hair**: not stretched into spikes or sheets, no holes showing magenta through the body.
  5. **Overall**: the pose matches the clip name (walk looks like walking, attack like attacking).
- Tell it to report only what it can see, with file names, as: `severity | character | clip | what is wrong | which file`.

## 3. Report

Merge the numbers and the reviewer's findings into one list, most severe first, each with the close-up file and how to
reproduce (model + clip + time from report.json). Do not call a character fine because the numbers passed if the
reviewer saw a problem, or the other way round: say which source found what.
