# rigcheck

Find broken skinning, smeared heads, missing body parts and impossible poses in rigged three.js characters, before
your players do. Built for the "I moved Mixamo animations onto a model from the internet and something looks off"
problem.

```bash
npx rigcheck --model zombie.glb --anims mixamo-moves.glb
```

It opens your normal browser (WebGL is needed for the close-ups), plays **every clip on every model**, measures, renders
close-ups on magenta, and writes `rigcheck-report/index.html`, `report.json` and the images. It exits with code 1 if
anything failed, so it works in CI too.

## What it checks

Every number is a measurement, not a guess:

| Check | How | Catches |
|---|---|---|
| **Mesh tearing / smearing** | every triangle edge, every sampled frame, against the bind pose; share of edges stretched past 3x and 5x | broken skin weights, bad retargets, heads smeared into flaps |
| **Nothing attached** | total skin weight on the head, hands and feet bones (and their children) | body parts left out on export, or parented to a bone without skinning |
| **Head below the shoulders** | head joint vs shoulder line, upright clips only | necks folding into the chest |
| **Neck bend** | angle between chest→neck and neck→head | heads snapped forward or back |
| **Bone length** | distance to the parent bone vs rest | retargets that scale bones |
| **See-through body** | share of triangles on alpha-blended materials | dark or missing faces from wrong sorting |
| **Missing textures** | materials without a colour texture while others have one | textures lost on export |
| **NaN** | non-finite vertex positions | broken transforms |
| **Matches the source** | for library clips: spine and neck direction on the source skeleton vs the model, frame by frame | retargets that change the motion, vs "the clip itself looks like that" |

Thresholds were calibrated on real retargeted characters: models that look right never had more than 1.5% of edges
past 3x in any clip; a broken one had 3–15%. Override any limit in code (`LIMITS` in `web/checks.js`).

Animation libraries (`--anims`) are moved onto each model by bone structure, not bone names, so Mixamo clips work on
Mixamo, Maya, 3ds Max, Rigify and home-made humanoid rigs, including twist bones.

## Options

```
--model, -m   a GLB/GLTF character (rigged). Repeat for several. Its own animations are checked too.
--anims, -a   a GLB with animation clips on a humanoid skeleton (e.g. Mixamo); every clip is moved onto every model
--clips       only these clip names (comma separated)
--frames      frames sampled per clip (default 12)
--size        close-up size in pixels (default 384)
--out, -o     report folder (default rigcheck-report)
--no-open     print the URL instead of opening a browser (e.g. to drive it with Playwright)
```

## Use the checks in your own code

```js
import { auditCharacter } from 'rigcheck/checks';
const report = auditCharacter(gltf.scene, gltf.animations, { frames: 12 });
console.log(report.status, report.clips.filter(c => c.status !== 'ok'));
```

## With Claude Code (or any coding agent)

Numbers catch broken geometry; they don't judge whether a pose looks right. `skill/SKILL.md` is a Claude Code skill
that runs rigcheck and then has a **separate reviewer agent** go through every close-up with a fixed checklist, without
seeing your notes, so it doesn't share your blind spots. Copy the `skill` folder to `~/.claude/skills/rigcheck/`.

## Limits

- Humanoid checks need a head, two hands and two feet it can find; other rigs get the mesh checks only.
- Knee and elbow direction checks are not in yet (rigs disagree about which way is forward).
- "Matches the source" only judges spine and neck for now: on clips with big root motion (falls, stand-ups) limb
  directions disagree with the source on every model alike, which points at the comparison, not the models.
- The numbers can't tell "head hidden face-down in a deep hunch" from "head missing"; the top-down close-up and the
  reviewer agent can, and the reviewer can over-call it too. Use both and check one against the other.
- The close-ups need WebGL, so headless browsers without a GPU produce blank images; the numbers still work.

## Licence

MIT
