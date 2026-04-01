import './style.css'

/**
 * Animated grain (#noiseTurb) — tweak these for speed / intensity of motion.
 *
 * | Property            | Default | Effect |
 * |---------------------|---------|--------|
 * | enabled             | true    | Turn animation off to save CPU. |
 * | speed               | 1.35    | Multiplies time → faster shimmer / drift. |
 * | baseFreqX, baseFreqY| 0.82, .79 | Center scale of the noise (higher = finer specks). |
 * | wobble              | 0.055   | How much baseFrequency oscillates (shimmer strength). |
 * | wobble2Amount       | 0.022   | Second wobble layer (irregular crawl). |
 * | phaseRate           | 2.8     | Radians per second for the main wave (higher = busier). |
 * | useRandomSeed       | false   | true = TV-static: new random `seed` every seedIntervalMs. |
 * | seedIntervalMs      | 48      | Only when useRandomSeed (lower = harsher static). |
 */
const GRAIN = {
  enabled: true,
  speed: 1.35,
  baseFreqX: 0.82,
  baseFreqY: 0.79,
  wobble: 0.55,
  wobble2Amount: 0.022,
  phaseRate: 0.01,
  useRandomSeed: true,
  seedIntervalMs: 48,
};

const noiseTurb = document.getElementById('noiseTurb');

const svg = document.getElementById('scene');
const lightRays = document.getElementById('light-rays');
const target = document.getElementById('target');
const lights = [
  document.getElementById('light0'),
  document.getElementById('light1'),
  document.getElementById('light2'),
  document.getElementById('light3'),
];
const rayGrads = [
  document.getElementById('rayGrad0'),
  document.getElementById('rayGrad1'),
  document.getElementById('rayGrad2'),
  document.getElementById('rayGrad3'),
];

/**
 * Target square half-edge (offset from aim point `mx,my` to each side), SVG user units.
 * Closer to the viewBox center → larger (“light falling on you”); toward edges/corners → smaller.
 *
 * | Location              | Approx. half-edge | Notes                        |
 * |-----------------------|-------------------|------------------------------|
 * | ViewBox center        | 280               | Largest (~1.87× vs at edge)  |
 * | Corners / far from C  | 150               | Smallest baseline            |
 *
 * Tweak TARGET_SIZE_AT_EDGE / TARGET_SIZE_AT_CENTER to taste.
 */
const TARGET_SIZE_AT_EDGE = 60;
const TARGET_SIZE_AT_CENTER = 200;

/**
 * X component of the first `translate(tx, ty)` on #source-group.
 * Light quads + gradients use root user space; the white #source lives in the group’s local space,
 * so rays must use local corners + this offset (keeps in sync with whatever you set in HTML).
 */
function parseSourceGroupTranslateX() {
  const el = document.getElementById('source-group');
  const t = el?.getAttribute('transform') ?? '';
  const m = t.match(/translate\s*\(\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+))?\s*\)/i);
  return m ? Number(m[1]) : 0;
}

const SOURCE_GROUP_TX = parseSourceGroupTranslateX();

// Local square inside #source-group: TL, TR, BR, BL — half-edge 80 (matches #source points in HTML)
const sourcePtsLocal = [
  { x: 420, y: 420 },
  { x: 580, y: 420 },
  { x: 580, y: 580 },
  { x: 420, y: 580 },
];

/** World-space vertices for light polygons + gradients (matches drawn #source after group transform). */
const sourcePts = sourcePtsLocal.map((p) => ({
  x: p.x + SOURCE_GROUP_TX,
  y: p.y,
}));

function parseViewBox(el) {
  const vb = el.getAttribute('viewBox');
  if (!vb) return { minX: 0, minY: 0, width: 1000, height: 1000 };
  const [minX, minY, width, height] = vb.trim().split(/\s+/).map(Number);
  return { minX, minY, width, height };
}

function clientToSvg(clientX, clientY) {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: clientX, y: clientY };
  return pt.matrixTransform(ctm.inverse());
}

function quadPoints(s0, t0, t1, s1) {
  return `${s0.x},${s0.y} ${t0.x},${t0.y} ${t1.x},${t1.y} ${s1.x},${s1.y}`;
}

function mid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Per frustum face: bright at source edge, fade toward target edge (follows mouse angularly). */
function setFaceRayGradient(grad, sA, sB, tA, tB, box) {
  const p1 = mid(sA, sB);
  const p2 = mid(tA, tB);
  const end = gradientEndClampedToViewBox(p1.x, p1.y, p2.x, p2.y, box);
  grad.setAttribute('x1', p1.x);
  grad.setAttribute('y1', p1.y);
  grad.setAttribute('x2', end.x);
  grad.setAttribute('y2', end.y);
}

/**
 * Liang–Barsky: segment P(u)=P0+u*(P1-P0), u in [0,1], clipped to axis-aligned rect.
 * Returns u0,u1 for the visible subsegment, or null if empty.
 */
function segmentClipU0U1(x0, y0, x1, y1, minX, minY, maxX, maxY) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let u0 = 0;
  let u1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - minX, maxX - x0, y0 - minY, maxY - y0];
  for (let i = 0; i < 4; i++) {
    const pi = p[i];
    const qi = q[i];
    if (Math.abs(pi) < 1e-9) {
      if (qi < 0) return null;
      continue;
    }
    const t = qi / pi;
    if (pi < 0) {
      if (t > u1) return null;
      if (t > u0) u0 = t;
    } else {
      if (t < u0) return null;
      if (t < u1) u1 = t;
    }
  }
  if (u0 > u1) return null;
  return { u0, u1 };
}

/**
 * End of gradient segment from origin toward target: target if inside rect, else last
 * point inside the rect along the segment (viewBox boundary), so beyond maps to 100% stop (transparent).
 */
function gradientEndClampedToViewBox(ox, oy, tx, ty, box) {
  const maxX = box.minX + box.width;
  const maxY = box.minY + box.height;
  const clip = segmentClipU0U1(ox, oy, tx, ty, box.minX, box.minY, maxX, maxY);
  if (!clip) {
    return { x: ox, y: oy };
  }
  return {
    x: ox + clip.u1 * (tx - ox),
    y: oy + clip.u1 * (ty - oy),
  };
}

function viewBoxCenter(box) {
  return {
    x: box.minX + box.width / 2,
    y: box.minY + box.height / 2,
  };
}

/** 0 at center, 1 at viewBox corners (clamped), smooth in between. */
function normalizedDistanceFromViewBoxCenter(px, py, box) {
  const c = viewBoxCenter(box);
  const halfDiag = Math.hypot(box.width / 2, box.height / 2);
  const d = Math.hypot(px - c.x, py - c.y);
  return Math.min(1, d / halfDiag);
}

function smoothstep01(t) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** Maps cursor position → target size: max at center, min toward edges. */
function targetSizeForAimPoint(mx, my, box) {
  const t = normalizedDistanceFromViewBoxCenter(mx, my, box);
  const eased = smoothstep01(t);
  return (
    TARGET_SIZE_AT_CENTER +
    eased * (TARGET_SIZE_AT_EDGE - TARGET_SIZE_AT_CENTER)
  );
}

let pointerOverSvg = false;

function updateSceneFromClient(clientX, clientY) {
  const { x: mx, y: my } = clientToSvg(clientX, clientY);
  const box = parseViewBox(svg);

  const size = targetSizeForAimPoint(mx, my, box);
  const targetPts = [
    { x: mx - size, y: my - size },
    { x: mx + size, y: my - size },
    { x: mx + size, y: my + size },
    { x: mx - size, y: my + size },
  ];

  target.setAttribute(
    'points',
    targetPts.map((p) => `${p.x},${p.y}`).join(' '),
  );

  const n = sourcePts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    lights[i].setAttribute(
      'points',
      quadPoints(sourcePts[i], targetPts[i], targetPts[j], sourcePts[j]),
    );
    setFaceRayGradient(
      rayGrads[i],
      sourcePts[i],
      sourcePts[j],
      targetPts[i],
      targetPts[j],
      box,
    );
  }
}

function onSvgPointerEnter(e) {
  pointerOverSvg = true;
  lightRays?.classList.add('rays-active');
  svg?.classList.add('scene-active');
  updateSceneFromClient(e.clientX, e.clientY);
}

function onSvgPointerLeave() {
  pointerOverSvg = false;
  lightRays?.classList.remove('rays-active');
  svg?.classList.remove('scene-active');
}

svg.addEventListener('pointerenter', onSvgPointerEnter);
svg.addEventListener('pointerleave', onSvgPointerLeave);

document.addEventListener('mousemove', (e) => {
  if (!pointerOverSvg) return;
  updateSceneFromClient(e.clientX, e.clientY);
});

// ─── Film grain: animate feTurbulence baseFrequency (and optional seed) ─────
let grainTime = 0;
let grainLastPerf = performance.now();
let grainLastSeedAt = 0;

function grainFrame(now) {
  requestAnimationFrame(grainFrame);
  if (!GRAIN.enabled || !noiseTurb) return;

  const dt = Math.min(0.05, (now - grainLastPerf) / 1000);
  grainLastPerf = now;
  grainTime += dt * GRAIN.speed;

  const p1 = grainTime * GRAIN.phaseRate;
  const p2 = grainTime * GRAIN.phaseRate * 1.713;

  const wx =
    GRAIN.wobble * Math.sin(p1) +
    GRAIN.wobble2Amount * Math.sin(p2);
  const wy =
    GRAIN.wobble * Math.cos(p1 * 0.9) +
    GRAIN.wobble2Amount * Math.cos(p2 * 1.07);

  const fx = Math.max(0.12, GRAIN.baseFreqX + wx);
  const fy = Math.max(0.12, GRAIN.baseFreqY + wy);
  noiseTurb.setAttribute('baseFrequency', `${fx} ${fy}`);

  if (GRAIN.useRandomSeed) {
    if (now - grainLastSeedAt >= GRAIN.seedIntervalMs) {
      grainLastSeedAt = now;
      noiseTurb.setAttribute('seed', String(Math.floor(Math.random() * 4096)));
    }
  }
}

requestAnimationFrame(grainFrame);
