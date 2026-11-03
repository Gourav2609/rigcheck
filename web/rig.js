// Finds the body parts in any humanoid skeleton and moves animation from one skeleton onto another.
//
// Every model we use comes with a different rig (Mixamo names, Rigify names, Unreal names, home-made names), so
// nothing here trusts bone names beyond the five ends of the body: head, two hands, two feet. The rest is found by
// walking the hierarchy between them. Animation is moved as world-space rotation relative to a shared T-pose, so the
// bones' own axes and rolls never matter: a forearm that bends forward on the source bends forward on the target.
import * as THREE from 'three';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _s = new THREE.Vector3();

const SKIP = /ik|target|pole|ctrl|control|_end|end$|leaf|headtop|twist|roll|fk/i;
const FINGERS = { thumb: /thumb/i, index: /index|point/i, middle: /middle/i, ring: /ring/i, pinky: /pink|little/i };

function base(name) {
  return name
    .replace(/^mixamorig:?/i, '')
    .replace(/^DEF-/i, '')
    .replace(/_?metarig[.\d]*$/i, '')
    .replace(/_\d+$/, '');
}

// GLTFLoader drops dots from names, so "hand.L" arrives as "handL" and "toe.L_01" as "toeL_01"
const SIDE_TAIL = /(?<=[a-z0-9])([LR])$/;
const SIDE_SEP = /(^|[_\s-])([lr])(?=[_\s-]|\d|$)/i;

export function sideOf(name) {
  const n = base(name);
  if (/left/i.test(n)) return 'L';
  if (/right/i.test(n)) return 'R';
  const t = SIDE_TAIL.exec(n);
  if (t) return t[1];
  const m = SIDE_SEP.exec(n);
  return m ? m[2].toUpperCase() : '';
}

function stripSide(name) {
  return base(name).replace(/left|right/ig, '').replace(SIDE_TAIL, '').replace(new RegExp(SIDE_SEP.source, 'ig'), '$1')
    .replace(/^[_\s-]+|[_\s-]+$/g, '').toLowerCase();
}

function worldPos(o, out) { return out.setFromMatrixPosition(o.matrixWorld); }
function worldQuat(o, out) { o.matrixWorld.decompose(_v2, out, _s); return out; }

// bones that drive the mesh (skin joints), minus helper bones
function deformBones(root) {
  const set = new Set();
  root.traverse(o => { if (o.isSkinnedMesh) for (const b of o.skeleton.bones) set.add(b); });
  if (!set.size) root.traverse(o => { if (o.isBone) set.add(o); });
  return [...set].filter(b => !SKIP.test(base(b.name)));
}

function ancestors(b) { const a = []; for (let p = b.parent; p; p = p.parent) a.push(p); return a; }

function pick(bones, test, side) {
  const c = bones.filter(b => test(stripSide(b.name)) && (side === undefined || sideOf(b.name) === side));
  // the one closest to the root wins (a "foot" may have a "foot_end" or toe under it)
  c.sort((a, b) => ancestors(a).length - ancestors(b).length);
  return c[0] || null;
}

// chain of deform bones from `end` up to (not including) the first ancestor in `stop`
// twist segments (Rigify's DEF-forearm.L -> DEF-forearm.L.001, arrives as DEF-forearmL001) are one limb part: keep the first
const twinOf = (a, b) => b.name.replace(/[._]?0*\d+$/, '') === a.name && b.name !== a.name;

function chainUp(end, stop, deform, twins = false) {
  const out = [end];
  for (let p = end.parent; p && !stop.has(p); p = p.parent) if (deform.has(p)) out.unshift(p);
  return twins ? out.filter((b, i) => !(i > 0 && twinOf(out[i - 1], b))) : out;
}

/**
 * Map a skeleton onto named parts: hips, spine[], chest, neck, head, and per side shoulder, upperArm, lowerArm, hand,
 * upperLeg, lowerLeg, foot, toes, fingers{thumb:[..],index:[..],...}. Also finds which way the model faces.
 */
export function mapRig(root, over = {}) {
  root.updateMatrixWorld(true);
  const list = deformBones(root);
  const deform = new Set(list);
  let head = pick(list, n => /^head$|^head\b|^head[._]|^head\d/.test(n) && !/top|target|end/.test(n));
  if (!head) {
    // Rigify calls the head DEF-spine.006: take the highest spine-chain bone
    const spineish = list.filter(b => /spine|neck/i.test(b.name));
    head = spineish.sort((a, b) => worldPos(b, new THREE.Vector3()).y - worldPos(a, new THREE.Vector3()).y)[0] || null;
  }
  const hand = {
    L: pick(list, n => /^(hand|wrist|palm)$/.test(n), 'L'),
    R: pick(list, n => /^(hand|wrist|palm)$/.test(n), 'R'),
  };
  const foot = {
    L: pick(list, n => /^(ankle|anke)$/.test(n), 'L') || pick(list, n => /^foot$/.test(n), 'L'),
    R: pick(list, n => /^(ankle|anke)$/.test(n), 'R') || pick(list, n => /^foot$/.test(n), 'R'),
  };
  for (const [k, v] of Object.entries({ head, handL: hand.L, handR: hand.R, footL: foot.L, footR: foot.R })) {
    if (!v) throw new Error(`rig: no ${k} among ${list.map(b => b.name).join(' ')}`);
  }
  const spineSet = new Set([head, ...ancestors(head)]);
  // hips: where the two legs join the head's line
  const legJoin = ancestors(foot.L).find(a => spineSet.has(a) && ancestors(foot.R).includes(a));
  const armJoin = ancestors(hand.L).find(a => spineSet.has(a) && ancestors(hand.R).includes(a));
  let hips = legJoin;
  while (hips && !deform.has(hips)) hips = hips.children.find(c => spineSet.has(c)) || null;
  const line = chainUp(head, new Set(ancestors(hips)), deform); // hips .. head
  const chestIdx = line.indexOf(armJoin) >= 0 ? line.indexOf(armJoin) : line.length - 2;
  const map = { hips: line[0], head, chest: line[chestIdx], spine: line.slice(1, chestIdx), neck: line.slice(chestIdx + 1, -1) };

  for (const s of ['L', 'R']) {
    const arm = chainUp(hand[s], spineSet, deform, true); // [shoulder?] upper lower hand
    const leg = chainUp(foot[s], spineSet, deform, true); // [pelvis?] upper lower foot
    const n = arm.length;
    map['hand' + s] = arm[n - 1];
    map['lowerArm' + s] = arm[n - 2];
    map['upperArm' + s] = arm[n - 3];
    map['shoulder' + s] = n >= 4 ? arm[n - 4] : null;
    const m = leg.length;
    map['foot' + s] = leg[m - 1];
    map['lowerLeg' + s] = leg[m - 2];
    map['upperLeg' + s] = leg[m - 3];
    map['toes' + s] = map['foot' + s].children.find(c => deform.has(c)) || null;
    const fingers = {};
    for (const c of map['hand' + s].children) {
      if (!deform.has(c)) continue;
      const kind = Object.keys(FINGERS).find(k => FINGERS[k].test(base(c.name)));
      if (!kind) continue;
      const chain = [c];
      for (let b = c; b.children.length;) { b = b.children.find(x => deform.has(x)); if (!b) break; chain.push(b); }
      fingers[kind] = chain.slice(0, 3);
    }
    map['fingers' + s] = fingers;
  }
  // explicit bone names for rigs the walk above gets wrong (names without the loader's _NNN suffix)
  for (const [k, name] of Object.entries(over)) {
    let b = null;
    root.traverse(o => { if (o.isBone && !b && o.name.replace(/_\d+$/, '') === name) b = o; });
    if (!b) throw new Error(`rig: override ${k}=${name} not found`);
    map[k] = b;
  }
  // facing: the left side is +x for a model facing +z
  const left = worldPos(map.upperLegL, new THREE.Vector3()).sub(worldPos(map.upperLegR, _v));
  left.y = 0; left.normalize();
  const fwd = new THREE.Vector3().crossVectors(left, new THREE.Vector3(0, 1, 0));
  map.yaw = Math.atan2(fwd.x, fwd.z); // rotate the model by -yaw to face +z
  return map;
}

// every mapped bone with its canonical key, parents before children
function pairs(map) {
  const out = [['hips', map.hips]];
  map.spine.forEach((b, i) => out.push(['spine' + i, b]));
  out.push(['chest', map.chest]);
  map.neck.forEach((b, i) => out.push(['neck' + i, b]));
  out.push(['head', map.head]);
  for (const s of ['L', 'R']) {
    for (const k of ['shoulder', 'upperArm', 'lowerArm', 'hand', 'upperLeg', 'lowerLeg', 'foot', 'toes']) {
      if (map[k + s]) out.push([k + s, map[k + s]]);
    }
    for (const [f, chain] of Object.entries(map['fingers' + s])) chain.forEach((b, i) => out.push([`${f}${i}${s}`, b]));
  }
  return out;
}

// rotate bone b (in world space) so the direction from b to `to` points along `dir`; optionally also turn it about
// that line so the direction to `side` lines up with `sideDir`
function aim(b, to, dir, side, sideDir) {
  b.updateWorldMatrix(true, true);
  const p = worldPos(b, new THREE.Vector3());
  const a = worldPos(to, new THREE.Vector3()).sub(p).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(a, dir);
  if (side) {
    const s = worldPos(side, new THREE.Vector3()).sub(p).applyQuaternion(q);
    s.addScaledVector(dir, -s.dot(dir));
    const t = sideDir.clone().addScaledVector(dir, -sideDir.dot(dir));
    if (s.lengthSq() > 1e-10 && t.lengthSq() > 1e-10) {
      s.normalize(); t.normalize();
      q.premultiply(new THREE.Quaternion().setFromUnitVectors(s, t));
    }
  }
  const wq = worldQuat(b, new THREE.Quaternion()).premultiply(q);
  const pq = worldQuat(b.parent, new THREE.Quaternion());
  b.quaternion.copy(pq.invert().multiply(wq));
  b.updateWorldMatrix(false, true);
}

const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const NX = X.clone().negate(), NY = Y.clone().negate();

// Some exported rigs leave a hand or foot hanging off a helper bone instead of the forearm or shin (Blender
// constraints don't export). For those, remember where the part sits in its real parent's frame and put it back there
// every frame.
const LINKS = [['toesL', 'footL'], ['toesR', 'footR'], ['handL', 'lowerArmL'], ['handR', 'lowerArmR'], ['footL', 'lowerLegL'], ['footR', 'lowerLegR'],
  ['lowerArmL', 'upperArmL'], ['lowerArmR', 'upperArmR'], ['lowerLegL', 'upperLegL'], ['lowerLegR', 'upperLegR']];

function findFollows(map) {
  const out = [];
  for (const [c, p] of LINKS) {
    const child = map[c], parent = map[p];
    if (!child || !parent || ancestors(child).includes(parent)) continue;
    const offset = worldPos(child, new THREE.Vector3()).applyMatrix4(new THREE.Matrix4().copy(parent.matrixWorld).invert());
    out.push({ bone: child.name, to: parent.name, offset });
  }
  return out;
}

/** Bind follow records (by bone name) to the bones of one model instance. */
export function bindFollows(follows, root) {
  const byName = new Map();
  root.traverse(o => { if (o.isBone) byName.set(o.name, o); });
  return follows.map(f => ({ bone: byName.get(f.bone), to: byName.get(f.to), offset: f.offset }));
}

/** Put followed parts back on their real parents. Call after the mixer has posed the skeleton. */
export function applyFollows(bound) {
  for (const f of bound) {
    f.to.updateWorldMatrix(true, false);
    _v.copy(f.offset).applyMatrix4(f.to.matrixWorld);
    f.bone.parent.updateWorldMatrix(true, false);
    f.bone.position.copy(f.bone.parent.worldToLocal(_v));
    f.bone.updateMatrixWorld(true);
  }
}

/** Pose the skeleton in a standard T-pose: legs down, spine up, arms straight out, palms down, facing +z. */
export function tPose(map, follows = []) {
  const snap = () => { if (follows.length) { applyFollows(follows); } };
  const line = [map.hips, ...map.spine, map.chest, ...map.neck, map.head];
  aim(map.hips, line[1], Y, map.upperLegL, X);
  for (let i = 1; i < line.length - 1; i++) aim(line[i], line[i + 1], Y, i === line.indexOf(map.chest) && map.upperArmL ? map.upperArmL : null, X);
  for (const s of ['L', 'R']) {
    const out = s === 'L' ? X : NX;
    if (map['shoulder' + s]) aim(map['shoulder' + s], map['upperArm' + s], out);
    snap();
    aim(map['upperArm' + s], map['lowerArm' + s], out);
    snap();
    aim(map['lowerArm' + s], map['hand' + s], out);
    snap();
    const f = map['fingers' + s];
    const mid = (f.middle || f.index || [])[0];
    if (mid) aim(map['hand' + s], mid, out, f.thumb?.[0], Z);
    aim(map['upperLeg' + s], map['lowerLeg' + s], NY);
    snap();
    aim(map['lowerLeg' + s], map['foot' + s], NY);
    snap();
  }
}

/** Snapshot of a posed skeleton: world rotation per canonical key, hips height. */
export function snapshot(map, root) {
  root.updateMatrixWorld(true);
  const q = {};
  for (const [k, b] of pairs(map)) q[k] = worldQuat(b, new THREE.Quaternion());
  const hipsY = worldPos(map.hips, new THREE.Vector3()).y - Math.min(worldPos(map.footL, _v).y, worldPos(map.footR, _v2).y);
  return { q, hipsY, hipsPos: worldPos(map.hips, new THREE.Vector3()) };
}

/**
 * A rig ready for retargeting: the model wrapped so it faces +z, mapped, and with its T-pose reference taken.
 * The model's bones are left in T-pose.
 */
export function prepare(model, over = {}) {
  const wrap = new THREE.Group();
  wrap.add(model);
  let map = mapRig(wrap, over);
  wrap.rotation.y = -map.yaw;
  wrap.updateMatrixWorld(true);
  map = mapRig(wrap, over);
  const follows = findFollows(map);
  tPose(map, bindFollows(follows, wrap));
  const ref = snapshot(map, wrap);
  const box = new THREE.Box3();
  wrap.traverse(o => { if (o.isSkinnedMesh) box.expandByObject(o); });
  if (box.isEmpty()) {
    // skeleton-only files (animation libraries exported without skin): estimate from the bones, head top ~1.08x head joint
    const y = b => worldPos(b, new THREE.Vector3()).y;
    box.min.y = Math.min(y(map.footL), y(map.footR), map.toesL ? y(map.toesL) : Infinity) - 0.03 * (y(map.head) - y(map.footL));
    box.max.y = box.min.y + (y(map.head) - box.min.y) * 1.08;
  }
  ref.ground = box.min.y;
  ref.height = box.max.y - box.min.y;
  return { wrap, model, map, ref, list: pairs(map), follows };
}

/**
 * Move `clip` from the source rig onto the target rig. Both rigs must still be as prepare() left them: run this before
 * moving or scaling `wrap` (put instances in a parent group instead). Returns a new AnimationClip whose tracks address target bones by
 * name. `inPlace` removes the hips' horizontal travel (for loops that should stay on the spot).
 */
export function retarget(src, dst, clip, { fps = 30, inPlace = true, name = clip.name } = {}) {
  const mixer = new THREE.AnimationMixer(src.model);
  const action = mixer.clipAction(clip);
  action.play();
  const n = Math.max(2, Math.round(clip.duration * fps) + 1);
  const times = new Float32Array(n);
  const srcKeys = new Map(src.list);
  const tracks = [];
  const quatData = new Map(); // dst bone -> Float32Array
  for (const [k, b] of dst.list) if (srcKeys.has(k) || mapFallback(k, srcKeys)) quatData.set(b, { k, data: new Float32Array(n * 4) });
  const hipsPos = new Float32Array(n * 3);
  const scale = dst.ref.hipsY / src.ref.hipsY;
  const dstParent = new Map();
  for (const [, b] of dst.list) dstParent.set(b, b.parent);
  const qw = new Map(); // dst bone -> world quaternion this frame

  // dst world rotation of every ancestor up the chain (bones not driven keep their T-pose local rotation)
  const dstRoot = dst.wrap;
  dstRoot.updateMatrixWorld(true);
  const restLocal = new Map();
  dstRoot.traverse(o => restLocal.set(o, o.quaternion.clone()));
  const order = [];
  dstRoot.traverse(o => order.push(o));

  for (let f = 0; f < n; f++) {
    const t = Math.min(clip.duration, f / fps);
    times[f] = t;
    mixer.setTime(t);
    src.wrap.updateMatrixWorld(true);
    const sq = {};
    for (const [k, b] of src.list) sq[k] = worldQuat(b, new THREE.Quaternion());
    qw.clear();
    for (const o of order) {
      const pq = o.parent && qw.has(o.parent) ? qw.get(o.parent) : (o.parent ? worldQuat(o.parent, new THREE.Quaternion()) : new THREE.Quaternion());
      const e = quatData.get(o);
      let w;
      if (e) {
        const sk = srcKeys.has(e.k) ? e.k : mapFallback(e.k, srcKeys);
        // world = source world * inverse(source T-pose world) * target T-pose world
        w = sq[sk].clone().multiply(_q.copy(src.ref.q[sk]).invert()).multiply(dst.ref.q[e.k]);
        const local = pq.clone().invert().multiply(w);
        local.toArray(e.data, f * 4);
      } else {
        w = pq.clone().multiply(restLocal.get(o));
      }
      qw.set(o, w);
    }
    // hips travel, scaled by leg length
    const hp = worldPos(src.map.hips, new THREE.Vector3()).sub(src.ref.hipsPos).multiplyScalar(scale);
    if (inPlace) { hp.x = 0; hp.z = 0; }
    hipsPos.set([hp.x, hp.y, hp.z], f * 3);
  }
  for (const [b, e] of quatData) {
    // keep quaternion signs continuous so interpolation never takes the long way round
    for (let f = 1; f < n; f++) {
      const i = f * 4, j = i - 4;
      if (e.data[i] * e.data[j] + e.data[i + 1] * e.data[j + 1] + e.data[i + 2] * e.data[j + 2] + e.data[i + 3] * e.data[j + 3] < 0) {
        for (let c = 0; c < 4; c++) e.data[i + c] *= -1;
      }
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, e.data));
  }
  // hips offset is in wrap space; convert to the hips' parent space
  const hb = dst.map.hips;
  const inv = new THREE.Matrix4().copy(hb.parent.matrixWorld).invert();
  const base0 = dst.ref.hipsPos.clone();
  const pos = new Float32Array(n * 3);
  for (let f = 0; f < n; f++) {
    _v.set(hipsPos[f * 3], hipsPos[f * 3 + 1], hipsPos[f * 3 + 2]).add(base0).applyMatrix4(inv);
    _v.toArray(pos, f * 3);
  }
  tracks.push(new THREE.VectorKeyframeTrack(`${hb.name}.position`, times, pos));
  action.stop();
  mixer.uncacheRoot(src.model);
  return new THREE.AnimationClip(name, clip.duration, tracks);
}

// a target spine/neck bone with no partner of the same index on the source uses the nearest one the source has
function mapFallback(k, srcKeys) {
  const m = /^(spine|neck)(\d+)$/.exec(k);
  if (!m) return null;
  for (let i = +m[2]; i >= 0; i--) if (srcKeys.has(m[1] + i)) return m[1] + i;
  return m[1] === 'neck' ? 'chest' : 'hips';
}

export { pairs };
