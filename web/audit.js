// Runs in the browser (WebGL needed for the close-ups). Loads the models and animation libraries named in /config,
// moves library clips onto each model, runs the checks, renders close-ups on magenta and posts everything to /result.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { prepare, retarget } from './rig.js';
import { auditCharacter, compareToSource } from './checks.js';
import { mapRig } from './rig.js';

const logEl = document.getElementById('log');
const log = s => { logEl.textContent += '\n' + s; console.log('[rigcheck]', s); };

const cfg = await fetch('/config').then(r => r.json());
const SIZE = cfg.shotSize || 384;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(SIZE, SIZE, false);
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
// magenta makes grey wedges, holes and stray geometry obvious
scene.background = new THREE.Color(0xff00ff);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.6;
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.6));
const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(2, 4, 3); scene.add(key);
const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);

const loader = new GLTFLoader();
const libs = [];
for (const a of cfg.anims || []) {
  const g = await loader.loadAsync(a.url);
  libs.push({ name: a.name, src: prepare(g.scene), clips: g.animations });
  log(`animation library ${a.name}: ${g.animations.length} clips`);
}
const want = cfg.clips?.length ? new Set(cfg.clips) : null;

function fit(root, yaw, pitch = 0.08) {
  const box = new THREE.Box3();
  root.traverse(o => { if (o.isSkinnedMesh) { o.computeBoundingBox(); box.union(o.boundingBox.clone().applyMatrix4(o.matrixWorld)); } else if (o.isMesh) box.expandByObject(o); });
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  const r = Math.max(s.x, s.y, s.z) * 0.5;
  const d = r / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.08;
  camera.position.set(c.x + Math.sin(yaw) * Math.cos(pitch) * d, c.y + Math.sin(pitch) * d, c.z + Math.cos(yaw) * Math.cos(pitch) * d);
  camera.lookAt(c);
}
function shot(root, yaw, pitch) {
  root.updateMatrixWorld(true);
  fit(root, yaw, pitch);
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/jpeg', 0.85);
}
const VIEWS = { front: 0, side: Math.PI / 2, back: Math.PI, three_quarter: Math.PI / 4 };

const out = [];
for (const m of cfg.models) {
  log(`model ${m.name}: loading`);
  try {
    const g = await loader.loadAsync(m.url);
    let root = g.scene, clips = [...g.animations], prep = null;
    const origin = new Map(); // retargeted clip name -> { lib, clip } it came from
    if (libs.length) {
      prep = prepare(g.scene);
      root = prep.wrap;
      for (const lib of libs) for (const c of lib.clips) {
        if (want && !want.has(c.name)) continue;
        try { clips.push(retarget(lib.src, prep, c, { name: c.name })); origin.set(c.name, { lib, clip: c }); } catch (e) { log(`  could not move ${c.name}: ${e.message}`); }
      }
    }
    if (want) clips = clips.filter(c => want.has(c.name));
    scene.add(root);
    const t0 = performance.now();
    const audit = auditCharacter(root, clips, { frames: cfg.frames || 12 });
    // retarget fidelity: does the model move like the source skeleton did?
    if (prep) {
      const dmap = mapRig(root);
      for (const r of audit.clips) {
        const o = origin.get(r.clip);
        if (!o) continue;
        const c = clips.find(x => x.name === r.clip);
        r.fidelity = compareToSource({ root: o.lib.src.model, map: o.lib.src.map }, o.clip, { root, map: dmap }, c, cfg.frames || 12);
        // only spine and neck count for now: limb directions on clips with big root motion (falls) disagree on every model alike
        if (!r.fidelity.skipped && r.fidelity.spineDrift > (cfg.maxDrift || 35)) {
          r.flags.push({ level: 'warn', type: 'drift', time: r.fidelity.time, msg: `spine or neck moves differently from the source animation: off by ${r.fidelity.spineDrift}°` });
          if (r.status === 'ok') r.status = 'warn';
        }
      }
      if (audit.status === 'ok' && audit.clips.some(r => r.status !== 'ok')) audit.status = 'warn';
    }
    log(`  ${clips.length} clips checked in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${audit.status.toUpperCase()}`);
    // close-ups: the rest pose from four sides, then each clip at its worst frame (or its middle) from front and side
    const shots = { rest: {} };
    root.traverse(o => { if (o.isSkinnedMesh) o.skeleton.pose(); });
    for (const [v, yaw] of Object.entries(VIEWS)) shots.rest[v] = shot(root, yaw, 0.08);
    shots.clips = {};
    const mixer = new THREE.AnimationMixer(root);
    for (const c of clips) {
      const r = audit.clips.find(x => x.clip === c.name);
      const t = r && r.status !== 'ok' ? r.worstTime : c.duration * 0.5;
      const a = mixer.clipAction(c); a.play(); mixer.setTime(t);
      shots.clips[c.name] = { time: +t.toFixed(2), front: shot(root, 0, 0.08), side: shot(root, Math.PI / 2, 0.08), top: shot(root, 0.3, 1.2) };
      a.stop();
    }
    mixer.uncacheRoot(root);
    scene.remove(root);
    out.push({ name: m.name, audit, shots });
  } catch (e) {
    log(`  FAILED: ${e.message}`);
    out.push({ name: m.name, error: e.message });
  }
}
log('sending results…');
const res = await fetch('/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ models: out }) });
log(res.ok ? 'done: report written. You can close this tab.' : 'could not send results: ' + res.status);
window.__rigcheck = { done: true, models: out.map(m => ({ name: m.name, status: m.audit?.status || 'error' })) };
