// Automatic checks for a rigged, animated character. No AI involved: every finding is a measurement.
//
//   import { auditCharacter } from 'rigcheck/checks';
//   const report = auditCharacter(root, clips, { frames: 12 });
//
// root: an Object3D holding one or more SkinnedMeshes (e.g. gltf.scene), already in its rest pose.
// clips: THREE.AnimationClip[] that animate root's bones (by name).
//
// What it measures:
//   - mesh stretch: every triangle edge, every sampled frame, against the bind pose. Broken skin weights and bad
//     retargets show up as edges many times longer (or shorter) than they should be.
//   - pose sanity for humanoids: head sinking into the chest, head below the shoulders, necks bent past what a body can do,
//     bones that change length (a retarget scaling something it shouldn't), NaN transforms.
//   - parts with nothing attached: key bones (head, hands, feet) that no vertex follows, usually a missing mesh piece.
import * as THREE from 'three';
import { mapRig } from './rig.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _p = new THREE.Vector3(), _q = new THREE.Vector3();

/** Thresholds; override any of them through opts.limits. */
export const LIMITS = {
  stretch: 2.5,        // an edge longer than 2.5x its rest length counts as stretched (raised arms stretch armpits ~2x)
  squash: 0.3,         // shorter than 0.3x counts as crushed
  minEdge: 0.003,      // ignore edges shorter than this fraction of body height (decimation slivers swing wildly)
  // calibrated on four retargeted zombies: models that look right never had more than 1.5% of edges over 3x in any
  // clip; a broken one (head smeared into a flap) had 3-15% over 3x and up to 9% over 5x
  over3Warn: 0.0175,   // share of edges stretched past 3x in the worst frame: warn
  over3Fail: 0.03,     // ...fail
  over5Fail: 0.01,     // share past 5x: fail
  neckBend: 80,        // degrees between chest->neck and neck->head
  boneLength: 0.08,    // a bone changing length by more than 8% between frames
  minBone: 0.02,       // ignore bones shorter than this fraction of height (a pelvis sitting on its root)
  fold: 100,          // degrees between hips->chest and chest->head: past this the upper body folds over and the head ends up inside it
  headSink: 0.6,       // head joint closer to the chest than 60% of its rest distance: the head is sinking into the body
  headDrop: 0.15,      // head below the shoulder line by more than 15% of body height (zombies hunch on purpose)
};
// clips where lying, crawling or falling is the point: pose checks that assume an upright body are skipped
const LOW_CLIP = /death|dying|die|crawl|lay|lying|prone|fall|knock|stand.?up|get.?up|agoniz|bite|biting/i;

function skinnedMeshes(root) {
  const out = [];
  root.traverse(o => { if (o.isSkinnedMesh && o.visible !== false) out.push(o); });
  return out;
}

// triangle edges as pairs of vertex indices, one list per mesh
function edgesOf(mesh) {
  const g = mesh.geometry, idx = g.index ? g.index.array : null, n = idx ? idx.length : g.attributes.position.count;
  const e = new Uint32Array(n * 2);
  for (let t = 0, k = 0; t < n; t += 3) {
    const a = idx ? idx[t] : t, b = idx ? idx[t + 1] : t + 1, c = idx ? idx[t + 2] : t + 2;
    e[k++] = a; e[k++] = b; e[k++] = b; e[k++] = c; e[k++] = c; e[k++] = a;
  }
  return e;
}

function positions(mesh, out) {
  const n = mesh.geometry.attributes.position.count;
  for (let i = 0; i < n; i++) {
    mesh.getVertexPosition(i, _v).applyMatrix4(mesh.matrixWorld);
    out[i * 3] = _v.x; out[i * 3 + 1] = _v.y; out[i * 3 + 2] = _v.z;
  }
  return out;
}

const len = (P, a, b) => Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);

// the bone with the most weight on vertex i
function mainBone(mesh, i) {
  const si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
  let best = -1, bw = -1;
  for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
  return mesh.skeleton.bones[best]?.name || '?';
}

function tryMap(root) {
  try { return mapRig(root); } catch { return null; }
}

/** Static checks: things wrong in every frame. */
export function auditStatic(root) {
  const meshes = skinnedMeshes(root);
  const findings = [];
  if (!meshes.length) findings.push({ level: 'fail', type: 'no-skin', msg: 'no skinned mesh found' });
  const map = tryMap(root);
  if (!map) findings.push({ level: 'warn', type: 'not-humanoid', msg: 'could not find head, hands and feet; humanoid checks skipped' });
  // key bones that no vertex follows: usually a mesh piece that was left out or attached to the bone without skinning
  if (map) {
    for (const key of ['head', 'handL', 'handR', 'footL', 'footR']) {
      const bone = map[key];
      if (!bone) continue;
      // the bone itself or any of its children (fingers, jaw, eyes) counts
      const family = new Set(); bone.traverse(b => b.isBone && family.add(b));
      let weight = 0;
      for (const m of meshes) {
        const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
        const ids = new Set(m.skeleton.bones.map((b, i) => family.has(b) ? i : -1).filter(i => i >= 0));
        for (let i = 0; i < si.count; i++) for (let k = 0; k < 4; k++) if (ids.has(si.getComponent(i, k))) weight += sw.getComponent(i, k);
      }
      if (weight < 1) findings.push({ level: 'fail', type: 'nothing-attached', bone: bone.name, msg: `no mesh follows the ${key} bone (${bone.name}): a body part is probably missing or not skinned` });
    }
  }
  // a material without a colour texture when the others have one: usually a texture lost on export (renders flat or black)
  const mats = new Map();
  for (const m of meshes) for (const mat of [].concat(m.material)) mats.set(mat.uuid, mat);
  const textured = [...mats.values()].filter(m => m.map);
  if (textured.length) for (const mat of mats.values()) if (!mat.map && !mat.transparent) findings.push({ level: 'warn', type: 'no-texture', msg: `material "${mat.name || '?'}" has no colour texture while ${textured.length} other(s) do: it will render flat` + (mat.color && mat.color.getHSL({}).l < 0.15 ? ' and nearly black' : '') });
  // most of the body drawn see-through: real-time sorting breaks and faces go dark
  let blended = 0, all = 0;
  for (const m of meshes) {
    const n = (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
    all += n; if ([].concat(m.material).some(mt => mt.transparent && mt.opacity >= 0.99)) blended += n;
  }
  if (all && blended / all > 0.5) findings.push({ level: 'warn', type: 'alpha-body', msg: `${Math.round(blended / all * 100)}% of the triangles use alpha-blended (see-through) materials: expect wrong sorting and dark or missing faces; make skin and clothes opaque` });
  let tris = 0;
  for (const m of meshes) tris += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
  return { meshes: meshes.length, tris: Math.round(tris), bones: meshes[0]?.skeleton.bones.length || 0, humanoid: !!map, findings, map };
}

/** Animate root with each clip, sample frames, measure. Leaves root in its rest pose. */
export function auditCharacter(root, clips, opts = {}) {
  const L = { ...LIMITS, ...(opts.limits || {}) };
  const frames = opts.frames || 12;
  root.updateMatrixWorld(true);
  const meshes = skinnedMeshes(root);
  const stat = auditStatic(root);
  const map = stat.map;

  // rest lengths from the bind pose
  for (const m of meshes) m.skeleton.pose();
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const m of meshes) { m.computeBoundingBox(); box.union(m.boundingBox.clone().applyMatrix4(m.matrixWorld)); }
  const height = box.max.y - box.min.y || 1;
  const data = meshes.map(m => {
    const n = m.geometry.attributes.position.count;
    const edges = edgesOf(m), rest = positions(m, new Float32Array(n * 3));
    const restLen = new Float32Array(edges.length / 2);
    for (let i = 0; i < restLen.length; i++) restLen[i] = len(rest, edges[i * 2], edges[i * 2 + 1]);
    return { m, edges, restLen, cur: new Float32Array(n * 3) };
  });
  const headChestRest = map?.chest && map.head ? map.head.getWorldPosition(_v).distanceTo(map.chest.getWorldPosition(_w)) : 0;
  const boneRest = new Map();
  if (map) for (const [, b] of Object.entries(map)) if (b?.isBone && b.parent?.isBone) {
    const d = b.getWorldPosition(_v).distanceTo(b.parent.getWorldPosition(_w));
    if (d > L.minBone * height) boneRest.set(b, d);
  }

  const results = [];
  for (const clip of clips) {
    const mixer = new THREE.AnimationMixer(root);
    mixer.clipAction(clip).play();
    const low = LOW_CLIP.test(clip.name);
    const r = { clip: clip.name, duration: +clip.duration.toFixed(2), maxStretch: 1, minStretch: 1, worstBadPct: 0, worstTime: 0, worstBone: null, over: { x2: 0, x3: 0, x5: 0 }, flags: [] };
    const flag = (type, t, msg, level = 'warn') => { if (!r.flags.some(f => f.type === type)) r.flags.push({ level, type, time: +t.toFixed(2), msg }); };
    for (let f = 0; f < frames; f++) {
      const t = (clip.duration * f) / Math.max(1, frames - 1) * 0.999;
      mixer.setTime(t);
      root.updateMatrixWorld(true);
      // mesh stretch
      let bad = 0, total = 0, x2 = 0, x3 = 0, x5 = 0;
      const minLen = L.minEdge * height;
      for (const d of data) {
        positions(d.m, d.cur);
        for (let i = 0; i < d.restLen.length; i++) {
          const rl = d.restLen[i];
          if (rl < minLen) continue;
          const a = d.edges[i * 2], b = d.edges[i * 2 + 1], k = len(d.cur, a, b) / rl;
          total++;
          if (k > L.stretch || k < L.squash) bad++;
          if (k > 2) x2++; if (k > 3) x3++; if (k > 5) x5++;
          if (!(k <= r.maxStretch) && Number.isFinite(k)) { r.maxStretch = k; r.worstBone = mainBone(d.m, a); }
          if (k < r.minStretch) r.minStretch = k;
          if (!Number.isFinite(k)) flag('nan', t, 'vertex positions became NaN (a bone transform is broken)', 'fail');
        }
      }
      const pct = total ? bad / total : 0;
      if (pct > r.worstBadPct) { r.worstBadPct = pct; r.worstTime = t; }
      if (total) { r.over.x2 = Math.max(r.over.x2, x2 / total); r.over.x3 = Math.max(r.over.x3, x3 / total); r.over.x5 = Math.max(r.over.x5, x5 / total); }
      // pose sanity
      if (map) {
        const head = map.head.getWorldPosition(_v).clone();
        const sh = Math.max(map.upperArmL ? map.upperArmL.getWorldPosition(_w).y : -Infinity, map.upperArmR ? map.upperArmR.getWorldPosition(_w).y : -Infinity);
        if (!low && Number.isFinite(sh) && head.y < sh - L.headDrop * height) flag('head-drop', t, `head drops below the shoulders (${((sh - head.y) / height * 100).toFixed(0)}% of height)`);
        if (map.hips && map.chest) {
          const a = map.chest.getWorldPosition(_p).sub(map.hips.getWorldPosition(_q));
          const b = map.head.getWorldPosition(_w).sub(map.chest.getWorldPosition(_q));
          const deg = THREE.MathUtils.radToDeg(a.angleTo(b));
          if (deg > L.fold) flag('fold', t, `upper body folds over (${deg.toFixed(0)}° between spine and neck): the head ends up inside the body`, 'fail');
        }
        if (headChestRest > 0) {
          const k = map.head.getWorldPosition(_p).distanceTo(map.chest.getWorldPosition(_q)) / headChestRest;
          if (k < L.headSink) flag('head-sink', t, `head sinks into the chest: head-to-chest distance down to ${(k * 100).toFixed(0)}% of rest`, 'fail');
        }
        const neckBase = (map.neck[0] || map.head.parent);
        if (map.chest && neckBase && neckBase !== map.chest) {
          const a = neckBase.getWorldPosition(_p).sub(map.chest.getWorldPosition(_q)).normalize();
          const b = map.head.getWorldPosition(_w).sub(neckBase.getWorldPosition(_q)).normalize();
          const deg = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1)));
          if (deg > L.neckBend) flag('neck-bend', t, `neck bent ${deg.toFixed(0)}°`, deg > L.neckBend + 30 ? 'fail' : 'warn');
        }
        for (const [b, rl] of boneRest) {
          const k = b.getWorldPosition(_v).distanceTo(b.parent.getWorldPosition(_w)) / (rl || 1);
          if (Math.abs(k - 1) > L.boneLength) flag('bone-length', t, `bone ${b.name} changes length by ${((k - 1) * 100).toFixed(0)}%`);
        }
      }
    }
    const o3 = (r.over.x3 * 100).toFixed(1), o5 = (r.over.x5 * 100).toFixed(1);
    if (r.over.x3 > L.over3Fail || r.over.x5 > L.over5Fail) flag('stretch', r.worstTime, `mesh tears or smears: ${o3}% of edges stretch past 3x (${o5}% past 5x), worst near bone ${r.worstBone}`, 'fail');
    else if (r.over.x3 > L.over3Warn) flag('stretch', r.worstTime, `some stretching: ${o3}% of edges past 3x, near bone ${r.worstBone}`);
    for (const k of Object.keys(r.over)) r.over[k] = +(r.over[k] * 100).toFixed(2);
    r.maxStretch = +r.maxStretch.toFixed(2); r.minStretch = +r.minStretch.toFixed(2); r.worstBadPct = +(r.worstBadPct * 100).toFixed(2);
    r.status = r.flags.some(f => f.level === 'fail') ? 'fail' : r.flags.length ? 'warn' : 'ok';
    mixer.stopAllAction(); mixer.uncacheRoot(root);
    results.push(r);
  }
  for (const m of meshes) m.skeleton.pose();
  root.updateMatrixWorld(true);
  const { map: _, ...st } = stat;
  const status = st.findings.some(f => f.level === 'fail') || results.some(r => r.status === 'fail') ? 'fail'
    : st.findings.length || results.some(r => r.status === 'warn') ? 'warn' : 'ok';
  return { ...st, height: +height.toFixed(3), status, clips: results };
}

/**
 * Did moving the clip onto this model keep the motion? Compares the direction of the main body segments (spine, neck,
 * upper and lower arms and legs) on the source skeleton and on the model, frame by frame. A big difference means the
 * retarget changed the motion; a small one means "the clip itself looks like that".
 * src/dst: { root, map } (map from rig.js mapRig); srcClip/dstClip: the same clip for each.
 */
export function compareToSource(src, srcClip, dst, dstClip, frames = 12) {
  const segs = [['hips', 'chest'], ['chest', 'head'], ['upperArmL', 'lowerArmL'], ['lowerArmL', 'handL'], ['upperArmR', 'lowerArmR'],
    ['lowerArmR', 'handR'], ['upperLegL', 'lowerLegL'], ['lowerLegL', 'footL'], ['upperLegR', 'lowerLegR'], ['lowerLegR', 'footR']];
  const ms = new THREE.AnimationMixer(src.root), md = new THREE.AnimationMixer(dst.root);
  ms.clipAction(srcClip).play(); md.clipAction(dstClip).play();
  let worst = 0, worstSeg = null, worstTime = 0, spine = 0;
  const dir = (map, a, b) => map[b] && map[a] ? map[b].getWorldPosition(new THREE.Vector3()).sub(map[a].getWorldPosition(new THREE.Vector3())).normalize() : null;
  let hipsMax = -Infinity, hipsMin = Infinity;
  for (let f = 0; f < frames; f++) {
    const t = (srcClip.duration * f) / Math.max(1, frames - 1) * 0.999;
    ms.setTime(t); md.setTime(t);
    src.root.updateMatrixWorld(true); dst.root.updateMatrixWorld(true);
    const hy = src.map.hips.getWorldPosition(new THREE.Vector3()).y;
    hipsMax = Math.max(hipsMax, hy);
    hipsMin = Math.min(hipsMin, hy);
    for (const [a, b] of segs) {
      const u = dir(src.map, a, b), v = dir(dst.map, a, b);
      if (!u || !v) continue;
      const deg = THREE.MathUtils.radToDeg(u.angleTo(v));
      if (deg > worst) { worst = deg; worstSeg = `${a}->${b}`; worstTime = t; }
      if ((a === 'hips' || a === 'chest') && deg > spine) spine = deg;
    }
  }
  ms.stopAllAction(); ms.uncacheRoot(src.root); md.stopAllAction(); md.uncacheRoot(dst.root);
  // falls and stand-ups: the comparison isn't reliable yet when the body travels to or from the floor
  if (hipsMax > 0 && hipsMin < hipsMax * 0.5) return { skipped: 'big root motion (falls to or rises from the floor)' };
  return { maxDrift: Math.round(worst), spineDrift: Math.round(spine), segment: worstSeg, time: +worstTime.toFixed(2) };
}

/**
 * Colour a skinned mesh by how much it stretches in its current pose, for heatmap pictures: blue = up to 1.8x (normal joint
 * stretch), yellow = 2.4x, red = 3x or more (the fail level) (or crushed below 0.33x). Call prepareHeat once (at the rest pose), then
 * heat(state) after posing; it writes a 'color' attribute (use a material with vertexColors: true).
 */
export function prepareHeat(mesh) {
  mesh.updateMatrixWorld(true);
  const n = mesh.geometry.attributes.position.count, edges = edgesOf(mesh);
  const rest = positions(mesh, new Float32Array(n * 3)), restLen = new Float32Array(edges.length / 2);
  for (let i = 0; i < restLen.length; i++) restLen[i] = len(rest, edges[i * 2], edges[i * 2 + 1]);
  const color = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
  return { mesh, n, edges, restLen, cur: new Float32Array(n * 3), worst: new Float32Array(n), color };
}
// red = the fail level (3x); everyday joint stretch up to 1.8x stays blue
const _c = new THREE.Color(), STOPS = [[1, 0x2a6cf0], [1.8, 0x2a6cf0], [2.4, 0xf2d03b], [3, 0xf2443b]];
export function heat(state) {
  const { mesh, n, edges, restLen, cur, worst, color } = state;
  mesh.updateMatrixWorld(true);
  positions(mesh, cur);
  worst.fill(1);
  for (let i = 0; i < restLen.length; i++) {
    if (restLen[i] < 1e-6) continue;
    const a = edges[i * 2], b = edges[i * 2 + 1];
    let k = len(cur, a, b) / restLen[i];
    if (k < 1) k = 1 / Math.max(k, 1e-3); // crushing counts like stretching
    if (k > worst[a]) worst[a] = k;
    if (k > worst[b]) worst[b] = k;
  }
  for (let i = 0; i < n; i++) {
    const k = worst[i];
    let j = 0; while (j < STOPS.length - 2 && k > STOPS[j + 1][0]) j++;
    const [k0, c0] = STOPS[j], [k1, c1] = STOPS[j + 1];
    _c.setHex(c0).lerp(new THREE.Color(c1), THREE.MathUtils.clamp((k - k0) / (k1 - k0), 0, 1));
    color.setXYZ(i, _c.r, _c.g, _c.b);
  }
  color.needsUpdate = true;
  if (mesh.geometry.getAttribute('color') !== color) mesh.geometry.setAttribute('color', color);
  return state;
}
