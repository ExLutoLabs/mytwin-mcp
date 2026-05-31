# Profile v1 Hypergraph Rendering Spec

Self-contained technical reference for sub-phases 3 and 4. Provided by the user in place
of the missing `twin-domains-tight.html`. Treat as the canonical, signed-off reference.

**Do not change** SPREAD, JITTER_MULT, GAP, ITER, lighting intensities, halo opacities,
edge geometry params, or animation rates without explicit user approval. Hand-tuned values.

## Tech stack
- three.js r128 via CDN: `https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js`
- No build step, no module imports. Inline `<script>` in `profile.html`.

## Scene constants
```js
const SPREAD = 50;        // domain anchor radius (cluster-to-cluster distance)
const JITTER_MULT = 23;   // per-node random offset around domain anchor
const GAP = 2.0;          // minimum clear space between sphere surfaces in relaxation
const ITER = 120;         // max iterations for the relaxation pass
```

## Scene, camera, renderer
```js
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x05060e, 0.005);

const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 4000);
camera.position.set(0, 0, 150);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.getElementById('scene').appendChild(renderer.domElement);
```
For Profile: replace `innerWidth/innerHeight` with the container's `clientWidth/clientHeight`
(see "Container sizing").

## Lighting
```js
scene.add(new THREE.AmbientLight(0x404a66, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 1.4);
key.position.set(1, 1.2, 1);
scene.add(key);
const fill = new THREE.DirectionalLight(0x88aaff, 0.5);
fill.position.set(-1, -0.5, -0.5);
scene.add(fill);
const group = new THREE.Group();
scene.add(group);
```

## Domain palette
```js
const DOMAIN_COLOR = {
  "Vision & positioning":      0xFFD400,
  "Twin architecture":         0x00E0C6,
  "Voice & craft":             0xFF3D8B,
  "Roadmap & product build":   0x5B8CFF,
  "Orchestration & automation":0xFF7A1A,
  "Capability & clients":      0xA85CFF,
};
const DOMAIN_KEYS = Object.keys(DOMAIN_COLOR);
```
Domain→tag inference is static and lives in the API endpoint. Client uses the `domains`
block from `/api/profile/hypergraph` as source of truth for node→domain membership.

## Domain anchor distribution (golden-ratio spread)
```js
const domainAnchor = {};
DOMAIN_KEYS.forEach((d, i) => {
  const golden = 2.399963;
  const y = 1 - (i / (DOMAIN_KEYS.length - 1)) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const th = golden * i;
  domainAnchor[d] = new THREE.Vector3(
    Math.cos(th) * r, y * 0.85, Math.sin(th) * r
  ).multiplyScalar(SPREAD);
});
```

## Per-node jitter hash (deterministic by id)
```js
function hashVec(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const a = (h % 1000) / 1000 * 6.283;
  const b = ((h >>> 10) % 1000) / 1000 * Math.PI;
  return new THREE.Vector3(
    Math.sin(b) * Math.cos(a), Math.sin(b) * Math.sin(a), Math.cos(b)
  );
}
```

## Soft halo texture
```js
function makeHalo() {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(S/2, S/2, S * 0.18, S/2, S/2, S/2);
  grd.addColorStop(0,   'rgba(255,255,255,0.5)');
  grd.addColorStop(0.5, 'rgba(255,255,255,0.12)');
  grd.addColorStop(1,   'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(c);
}
const haloTex = makeHalo();
```

## Node creation
`ITEMS` = `nodes` array from API. `maxDeg` = max `degree` across items.
```js
const nodes = [];
const maxDeg = Math.max(...ITEMS.map(it => it.degree));
ITEMS.forEach((it, i) => {
  const v = domainAnchor[it.domain].clone();
  v.add(hashVec(it.id).multiplyScalar(JITTER_MULT));
  const col = new THREE.Color(DOMAIN_COLOR[it.domain] || 0xFFD400);
  const size = 2.2 + (it.degree / maxDeg) * 2.6;
  const mat = new THREE.MeshStandardMaterial({
    color: col, emissive: col.clone().multiplyScalar(0.35),
    roughness: 0.45, metalness: 0.1
  });
  const body = new THREE.Mesh(new THREE.SphereGeometry(size, 32, 32), mat);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: haloTex, color: col, transparent: true,
    blending: THREE.AdditiveBlending, opacity: 0.4, depthWrite: false
  }));
  const hs = size * 3.2;
  halo.scale.set(hs, hs, 1);
  body.position.copy(v);
  halo.position.copy(v);
  group.add(body); group.add(halo);
  nodes.push({
    it, body, halo, mat, color: col.getHex(),
    baseEmissive: 0.35, baseSize: size, baseHalo: hs, base: v.clone(), glow: 0
  });
});
```

## Separation pass (relaxation)
```js
(function relax() {
  for (let pass = 0; pass < ITER; pass++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i].base, b = nodes[j].base;
        const need = nodes[i].baseSize + nodes[j].baseSize + GAP;
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        let d = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (d < 1e-4) { b.x += 0.5; b.y -= 0.3; b.z += 0.2; d = 0.6; }
        if (d < need) {
          const push = (need - d) / 2;
          const ux = dx/d, uy = dy/d, uz = dz/d;
          a.x -= ux*push; a.y -= uy*push; a.z -= uz*push;
          b.x += ux*push; b.y += uy*push; b.z += uz*push;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  nodes.forEach(n => { n.body.position.copy(n.base); n.halo.position.copy(n.base); });
})();
```

## Edges (cylinders)
`EDGES` = `edges` array from API: `{ i, j, strength }`. `maxSh` computed locally.
```js
const _up = new THREE.Vector3(0, 1, 0);
const edges = [];
const maxSh = Math.max(...EDGES.map(e => e.strength));
EDGES.forEach(e => {
  const strength = e.strength / maxSh;
  const blend = new THREE.Color(nodes[e.i].color).lerp(new THREE.Color(nodes[e.j].color), 0.5);
  const r = 0.08 + strength * 0.10;
  const op = 0.22 + strength * 0.25;
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r, 1, 6, 1, true),
    new THREE.MeshBasicMaterial({ color: blend, transparent: true, opacity: op, depthWrite: false })
  );
  group.add(mesh);
  edges.push({ e, mesh, baseOp: op });
});
function orient(mesh, a, b) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.scale.set(1, len, 1);
  mesh.quaternion.setFromUnitVectors(_up, dir.clone().normalize());
}
edges.forEach(ed => orient(ed.mesh, nodes[ed.e.i].base, nodes[ed.e.j].base));
```

### Permission-scoped edges (Profile v1 rule, CRITICAL)
Render edges only where BOTH endpoints are accessible. The API already filters nodes by
permission; `EDGES` must reference only indices present in `nodes`. Drop any edge whose
`i` or `j` is not in the filtered set. Never render a "redacted edge" placeholder.
Inaccessible nodes do not exist for that viewer.

## Starfield (600 quiet stars, no motion)
```js
const sg = new THREE.BufferGeometry();
const sn = 600;
const sp = new Float32Array(sn * 3);
for (let i = 0; i < sn; i++) {
  const r = 320 + Math.random() * 800;
  const t = Math.random() * 6.28;
  const p = Math.acos(2 * Math.random() - 1);
  sp.set([ r*Math.sin(p)*Math.cos(t), r*Math.sin(p)*Math.sin(t), r*Math.cos(p) ], i * 3);
}
sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
scene.add(new THREE.Points(sg, new THREE.PointsMaterial({
  color: 0x8088bb, size: 1.1, transparent: true, opacity: 0.5
})));
```

## Interaction (drag turn, scroll zoom, hover tooltip)
```js
let userRotX = 0.15, userRotY = 0;
let dragging = false, lastX = 0, lastY = 0;
let tZoom = 150;
let autoYaw = 0;
const dom = renderer.domElement;
dom.addEventListener('pointerdown', e => {
  dragging = true; lastX = e.clientX; lastY = e.clientY;
  document.body.classList.add('grabbing');
});
addEventListener('pointerup', () => { dragging = false; document.body.classList.remove('grabbing'); });
addEventListener('pointermove', e => {
  hover(e);
  if (!dragging) return;
  userRotY += (e.clientX - lastX) * 0.005;
  userRotX += (e.clientY - lastY) * 0.005;
  userRotX = Math.max(-1.4, Math.min(1.4, userRotX));
  lastX = e.clientX; lastY = e.clientY;
});
addEventListener('wheel', e => {
  tZoom += e.deltaY * 0.06;
  tZoom = Math.max(70, Math.min(300, tZoom));
}, { passive: true });
```

## Hover tooltip
```js
const ray = new THREE.Raycaster();
const mvec = new THREE.Vector2();
const tip = document.getElementById('tip');
let hovered = null;
function hover(e) {
  mvec.x = (e.clientX / innerWidth) * 2 - 1;
  mvec.y = -(e.clientY / innerHeight) * 2 + 1;
  ray.setFromCamera(mvec, camera);
  const hits = ray.intersectObjects(nodes.map(n => n.body), false);
  if (hits.length) {
    const n = nodes.find(nd => nd.body === hits[0].object);
    hovered = n;
    tip.style.left = (e.clientX + 16) + 'px';
    tip.style.top = (e.clientY + 14) + 'px';
    const c = '#' + new THREE.Color(n.color).getHexString();
    tip.innerHTML =
      `<div class="tt" style="color:${c}">${n.it.domain} · ${n.it.degree} links</div>` +
      `${n.it.title}` +
      `<div class="tg">${n.it.tags.slice(0, 7).join('  ·  ')}</div>`;
    tip.style.opacity = 1; tip.style.transform = 'translateY(0)';
    dom.style.cursor = 'pointer';
  } else {
    hovered = null;
    tip.style.opacity = 0; tip.style.transform = 'translateY(5px)';
    dom.style.cursor = dragging ? 'grabbing' : 'grab';
  }
}
```
NOTE: tooltip injects `n.it.title` as HTML. For Profile, titles are user data — escape them
(textContent or an escape helper) to avoid HTML injection. Provenance shown alongside domain.

## Animation loop
```js
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  autoYaw += dt * 0.05;
  group.rotation.y = userRotY + autoYaw;
  group.rotation.x = userRotX;
  camera.position.z += (tZoom - camera.position.z) * 0.06;
  const hn = hovered ? new Set(hovered.it.siblings) : null;
  nodes.forEach((n, i) => {
    let tg = 0;
    if (hovered) { if (n === hovered) tg = 1; else if (hn.has(i)) tg = 0.5; }
    n.glow += (tg - n.glow) * 0.2;
    const s = n.baseSize * (1 + n.glow * 0.35);
    n.body.scale.setScalar(s / n.baseSize);
    n.mat.emissive.setHex(n.color);
    n.mat.emissive.multiplyScalar(n.baseEmissive + n.glow * 0.5);
    const dim = (hovered && n !== hovered && !hn.has(i)) ? 0.5 : 1;
    n.mat.opacity = dim; n.mat.transparent = dim < 1;
    n.halo.material.opacity = (0.35 + n.glow * 0.5) * dim;
    n.halo.scale.setScalar(n.baseHalo * (1 + n.glow * 0.3));
  });
  edges.forEach(ed => {
    let op = ed.baseOp;
    if (hovered) {
      const on = (ed.e.i === hovered.it.idx || ed.e.j === hovered.it.idx);
      op = on ? Math.min(0.9, ed.baseOp * 2.4) : ed.baseOp * 0.25;
    }
    ed.mesh.material.opacity = op;
  });
  renderer.render(scene, camera);
}
animate();
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
```

## Item data shape required by renderer
```js
{
  id: string,        // stable id, used by hashVec for deterministic jitter
  title: string,     // tooltip (escape as HTML)
  domain: string,    // one of DOMAIN_KEYS
  tags: string[],    // tooltip (slice 0-7)
  degree: number,    // total tag-overlap connections, controls node size
  idx: number,       // index in nodes array (edge highlighting) — can compute client-side
  siblings: number[] // indices of nodes sharing >=1 tag (hover dim) — can compute client-side
}
```

## Page CSS
```css
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400&family=Spline+Sans+Mono:wght@300;400&display=swap');
:root { --bg:#05060e; --ink:#eef0ff; --dim:#666e9a; }
* { margin:0; padding:0; box-sizing:border-box; }
html, body { width:100%; height:100%; overflow:hidden; background:var(--bg); color:var(--ink);
  font-family:'Spline Sans Mono', monospace; cursor:grab; }
body.grabbing { cursor:grabbing; }
#scene { position:absolute; inset:0; z-index:0; }   /* absolute inside container for Profile */
#atmosphere { position:absolute; inset:0; z-index:1; pointer-events:none;
  background:radial-gradient(ellipse 95% 95% at 50% 50%, transparent 38%, rgba(5,6,14,0.6) 100%); }
#grain { position:absolute; inset:-50%; z-index:2; pointer-events:none; opacity:0.03;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  animation:gr 9s steps(6) infinite; }
@keyframes gr { 0%,100%{transform:translate(0,0);} 50%{transform:translate(2%,-2%);} }
#tip { position:fixed; z-index:7; pointer-events:none; padding:11px 14px; border-radius:10px;
  background:rgba(9,11,24,0.92); border:1px solid rgba(150,160,220,0.2); backdrop-filter:blur(12px);
  font-size:12px; color:var(--ink); opacity:0; transform:translateY(5px);
  transition:opacity 0.14s, transform 0.14s; max-width:280px; }
#tip .tt { font-size:9px; letter-spacing:0.2em; text-transform:uppercase; margin-bottom:4px; }
#tip .tg { margin-top:7px; font-size:9.5px; color:var(--dim); letter-spacing:0.04em; line-height:1.6; }
```

## Container sizing for Profile page
The reference is full-viewport; Profile uses a top-window hypergraph that scrolls with the page.
```html
<div id="hypergraph-container" style="position:relative; height:100vh; width:100%;">
  <div id="scene"></div>
  <div id="atmosphere"></div>
  <div id="grain"></div>
  <div id="tip"></div>
</div>
```
```js
const container = document.getElementById('hypergraph-container');
renderer.setSize(container.clientWidth, container.clientHeight);
container.querySelector('#scene').appendChild(renderer.domElement);
addEventListener('resize', () => {
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(container.clientWidth, container.clientHeight);
});
```
Pointer coords: if the container starts at the top of the viewport, `clientX/clientY` work
as-is; if a header sits above it, subtract the header height. Hover NDC math must use the
container rect, not `innerWidth/innerHeight`, when the container is offset.

## Empty state (sub-phase 4)
Below threshold (suggested 5 accessible items), render placeholder nodes instead of / alongside
real ones. Same domain-anchor distribution but seven fixed slots, golden-ratio spread on a
smaller sphere (`SPREAD * 0.85`).

Visual differentiation:
- Halo opacity 0.25 (vs 0.4); material opacity 0.4 (vs 1.0)
- Dashed outline ring (LineSegments + LineDashedMaterial, or translucent 1.1x shell with stripe texture)
- Faint "+" overlay on hover (DOM element at projected screen position)

Seven personal-workspace placeholders:
1. Your writing voice
2. Your brand spec
3. Your operating principles
4. Your key frameworks
5. Your professional context
6. Your projects in flight
7. Your people and contacts

Tap → contextual modal per placeholder: free-form text field + optional file upload, then
`POST /api/profile/placeholder-fill` with `{ placeholder_id, content }`. Endpoint stores as a
knowledge item with appropriate tags + hidden `replaced_placeholder: {placeholder_id}`.
Dismiss (X on hover) → insert `profile_placeholder_dismissals(user_id, workspace_id, placeholder_id, dismissed_at)`.
