/*
 * app.js — WebGL2 による描画と、再生・カメラ操作の UI
 *
 * 座標系: J2000.0 黄道座標（単位 au）。z 軸が黄道の北。
 * 精度対策として、GPU に渡す座標はすべて「カメラの注視点からの相対座標」にする（CPU 側は倍精度）。
 */
(function () {
  'use strict';

  const A = window.Astro;
  const PL = A.PLANETS;
  const NP = PL.length;
  const SUN_IDX = NP; // 天体番号: 0〜7 が惑星、8 が太陽
  const DEG = Math.PI / 180;
  const FOV = 45 * DEG;
  const SUN_SCALE_MAX = 50; // 太陽の拡大倍率の上限（これ以上大きくすると水星の軌道を飲み込む）
  const RING_OUTER_KM = { 1: 141000, 2: 51500, 3: 130000, 4: 63500 };

  const $ = (id) => document.getElementById(id);
  function showError(msg) {
    const e = $('error');
    e.textContent = msg;
    e.classList.remove('hidden');
  }
  window.addEventListener('error', (ev) => showError('エラー: ' + ev.message));

  const canvas = $('scene');
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
  if (!gl) {
    showError('このブラウザは WebGL2 に対応していないため表示できません。');
    return;
  }

  /* =========================================================================
   * ベクトル・行列（行列は WebGL 用の列優先）
   * ======================================================================= */
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  }

  function lookAt(eye, center, up) {
    const z = norm(sub(eye, center));
    const x = norm(cross(up, z));
    const y = cross(z, x);
    return new Float32Array([
      x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
      -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
    ]);
  }

  function mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  }

  function invert(a) {
    const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = a;
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    const det = 1 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06);
    return new Float32Array([
      (a11 * b11 - a12 * b10 + a13 * b09) * det, (a02 * b10 - a01 * b11 - a03 * b09) * det,
      (a31 * b05 - a32 * b04 + a33 * b03) * det, (a22 * b04 - a21 * b05 - a23 * b03) * det,
      (a12 * b08 - a10 * b11 - a13 * b07) * det, (a00 * b11 - a02 * b08 + a03 * b07) * det,
      (a32 * b02 - a30 * b05 - a33 * b01) * det, (a20 * b05 - a22 * b02 + a23 * b01) * det,
      (a10 * b10 - a11 * b08 + a13 * b06) * det, (a01 * b08 - a00 * b10 - a03 * b06) * det,
      (a30 * b04 - a31 * b02 + a33 * b00) * det, (a21 * b02 - a20 * b04 - a23 * b00) * det,
      (a11 * b07 - a10 * b09 - a12 * b06) * det, (a00 * b09 - a01 * b07 + a02 * b06) * det,
      (a31 * b01 - a30 * b03 - a32 * b00) * det, (a20 * b03 - a21 * b01 + a22 * b00) * det,
    ]);
  }

  /** 自転軸 pole と自転角 angle から、天体固定座標の基底（列: e1, e2, pole）を作る */
  function bodyBasis(pole, angle) {
    const ref = Math.abs(pole[2]) < 0.99 ? [0, 0, 1] : [1, 0, 0];
    const e1 = norm(cross(ref, pole));
    const e2 = cross(pole, e1);
    const c = Math.cos(angle), s = Math.sin(angle);
    const r1 = [e1[0] * c + e2[0] * s, e1[1] * c + e2[1] * s, e1[2] * c + e2[2] * s];
    const r2 = [-e1[0] * s + e2[0] * c, -e1[1] * s + e2[1] * c, -e1[2] * s + e2[2] * c];
    return { e1, e2, mat: new Float32Array([...r1, ...r2, ...pole]) };
  }

  function hexToRgb(hex) {
    const v = parseInt(hex.slice(1), 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  }

  /* =========================================================================
   * シェーダー
   * ======================================================================= */
  const COMMON = `
precision highp float;
precision highp int;

float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
vec3 hash3(vec3 p) { return vec3(hash(p), hash(p + vec3(17.1, 3.7, 9.2)), hash(p + vec3(31.7, 23.3, 5.1))); }
float noise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.02 + vec3(1.7, 9.2, 3.4); a *= 0.5; } return s; }
float fbm3(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 3; i++) { s += a * noise(p); p = p * 2.03 + vec3(4.1, 1.3, 7.7); a *= 0.5; } return s / 0.875; }
float hash1(float n) { return fract(sin(n) * 43758.5453123); }
float noise1(float x) { float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(hash1(i), hash1(i + 1.0), f); }
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
vec3 tonemap(vec3 c) { c = 1.0 - exp(-max(c, 0.0)); return pow(c, vec3(1.0 / 2.2)); }

/* ---- 環（半径は km。fw はピクセル幅に相当する半径の変化量。細い環が消えないように使う） ---- */
float ringBand(float r, float r0, float r1, float fw) { fw = max(fw, 1.0); return smoothstep(r0 - fw, r0 + fw, r) * (1.0 - smoothstep(r1 - fw, r1 + fw, r)); }
float ringLine(float r, float c, float w, float fw) { float we = max(w, fw * 2.0); return (w / we) * (1.0 - smoothstep(we * 0.3, we * 0.5, abs(r - c))); }

// 光学的厚さ。1: 土星, 2: 天王星, 3: 木星, 4: 海王星（木星・海王星・天王星は見えるよう少し強調）
float ringTau(int type, float r, float fw) {
  float t = 0.0;
  if (type == 1) {
    float detail = clamp(1.0 - fw / 400.0, 0.0, 1.0);
    float fine = 1.0 + detail * (0.55 * (noise1(r / 310.0) - 0.5) + 0.4 * (noise1(r / 83.0) - 0.5));
    t += 0.015 * ringBand(r, 66900.0, 74490.0, fw);                                                         // D
    t += (0.05 + 0.10 * smoothstep(80000.0, 92000.0, r)) * ringBand(r, 74490.0, 91980.0, fw) * fine;        // C
    t += mix(0.9, 2.6, smoothstep(94000.0, 104000.0, r)) * ringBand(r, 91980.0, 117580.0, fw) * fine;     // B
    t += 0.08 * ringBand(r, 117580.0, 122170.0, fw) * fine;                                                  // カッシーニの間隙
    float a = ringBand(r, 122170.0, 136775.0, fw) * mix(0.75, 0.45, smoothstep(125000.0, 136000.0, r)) * fine;
    a *= (1.0 - 0.95 * ringLine(r, 133589.0, 325.0, fw)) * (1.0 - 0.9 * ringLine(r, 136505.0, 42.0, fw)); // エンケ・キーラーの間隙
    t += a;                                                                                                   // A
    t += 0.6 * ringLine(r, 140220.0, 500.0, fw);                                                              // F
  } else if (type == 2) {
    t += 0.9 * ringLine(r, 41837.0, 1.5, fw) + 1.5 * ringLine(r, 42234.0, 2.0, fw) + 0.9 * ringLine(r, 42571.0, 2.0, fw);
    t += 1.2 * ringLine(r, 44718.0, 7.0, fw) + 0.9 * ringLine(r, 45661.0, 8.0, fw) + 0.6 * ringLine(r, 47176.0, 1.6, fw);
    t += 3.0 * ringLine(r, 47627.0, 4.0, fw) + 1.5 * ringLine(r, 48300.0, 6.0, fw) + 3.0 * ringLine(r, 51149.0, 58.0, fw);
  } else if (type == 3) {
    t += 0.012 * ringBand(r, 92000.0, 122500.0, fw) + 0.05 * ringBand(r, 122500.0, 129000.0, fw);
  } else if (type == 4) {
    t += 0.03 * ringLine(r, 41900.0, 2000.0, fw) + 0.4 * ringLine(r, 53200.0, 113.0, fw);
    t += 0.02 * ringBand(r, 53200.0, 57200.0, fw) + 0.15 * ringLine(r, 57200.0, 100.0, fw) + 0.5 * ringLine(r, 62932.0, 50.0, fw);
  }
  return t;
}

vec3 ringColor(int type, float r) {
  if (type == 1) {
    vec3 c = srgb(vec3(0.52, 0.48, 0.43));
    c = mix(c, srgb(vec3(0.86, 0.77, 0.63)), smoothstep(91000.0, 93000.0, r));
    c = mix(c, srgb(vec3(0.55, 0.50, 0.45)), smoothstep(117000.0, 118000.0, r) * (1.0 - smoothstep(121700.0, 122600.0, r)));
    c = mix(c, srgb(vec3(0.80, 0.74, 0.64)), smoothstep(121700.0, 122600.0, r));
    return c * (0.9 + 0.2 * noise1(r / 900.0));
  }
  if (type == 2) return srgb(vec3(0.55, 0.55, 0.6));
  if (type == 3) return srgb(vec3(0.7, 0.55, 0.42));
  return srgb(vec3(0.6, 0.6, 0.66));
}

/* 楕円体とレイの交差（局所座標）。当たらなければ -1 */
float hitEllipsoid(vec3 ro, vec3 rd, vec3 radii) {
  vec3 o = ro / radii, d = rd / radii;
  float a = dot(d, d), b = dot(o, d), c = dot(o, o) - 1.0;
  float h = b * b - a * c;
  if (h < 0.0) return -1.0;
  return (-b - sqrt(h)) / a;
}
`;

  const V = (s) => '#version 300 es\n' + s;

  /* ---- 背景（天の川・マゼラン雲） ---- */
  const BG_VS = V(`
layout(location = 0) in vec2 aPos;
out vec2 vNdc;
void main() { vNdc = aPos; gl_Position = vec4(aPos, 0.0, 1.0); }`);

  const BG_FS = V(COMMON + `
in vec2 vNdc;
out vec4 outColor;
uniform mat4 uInvVP;
uniform vec3 uGP, uGC, uLMC, uSMC;
void main() {
  vec4 p = uInvVP * vec4(vNdc, 1.0, 1.0);
  vec3 d = normalize(p.xyz / p.w);
  float sb = dot(d, uGP);
  float cl = dot(d, uGC);
  float band = exp(-sb * sb / 0.010);
  float bulge = exp(-(1.0 - cl) * 3.5) * exp(-sb * sb / 0.03);
  float n1 = fbm(d * 3.5 + 2.0);
  float n2 = fbm(d * 11.0 + 7.0);
  float dust = smoothstep(0.42, 0.68, fbm(d * 6.0 + 13.0)) * exp(-sb * sb / 0.0035);
  float mw = (band * (0.25 + 0.9 * n1 * n1) + bulge * 1.4) * (1.0 - 0.8 * dust) * (0.7 + 0.6 * n2);
  vec3 col = mw * mix(vec3(0.42, 0.5, 0.75), vec3(1.0, 0.82, 0.6), clamp(bulge * 1.5, 0.0, 1.0)) * 0.022;
  float neb = pow(fbm(d * 2.2 + 31.0), 3.0);
  col += neb * mix(vec3(0.35, 0.12, 0.45), vec3(0.08, 0.2, 0.45), fbm(d * 1.7 + 5.0)) * 0.03;
  col += vec3(0.75, 0.75, 0.85) * (exp(-(1.0 - dot(d, uLMC)) / 0.0009) * 0.9 + exp(-(1.0 - dot(d, uSMC)) / 0.0004) * 0.6) * (0.5 + 0.7 * n2) * 0.03;
  col += vec3(0.0012, 0.0016, 0.0042);
  col = pow(col, vec3(1.0 / 2.2));
  col += (hash(vec3(gl_FragCoord.xy, 1.0)) - 0.5) / 255.0;
  outColor = vec4(col, 1.0);
}`);

  /* ---- 恒星 ---- */
  const STAR_VS = V(`
layout(location = 0) in vec3 aDir;
layout(location = 1) in vec4 aCol;
uniform mat4 uVP;
uniform float uDpr;
out vec3 vCol;
void main() {
  vec4 p = uVP * vec4(aDir, 0.0);
  gl_Position = p.xyww;
  gl_PointSize = aCol.a * uDpr;
  vCol = aCol.rgb;
}`);

  const STAR_FS = V(`
precision highp float;
in vec3 vCol;
out vec4 outColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float a = exp(-dot(c, c) * 4.5);
  outColor = vec4(vCol * a, 1.0);
}`);

  /* ---- 球（太陽・惑星）を四角形に描き、ピクセルごとにレイと交差させる ---- */
  const IMPOSTOR_VS = V(`
layout(location = 0) in vec2 aCorner;
uniform mat4 uViewProj;
uniform vec3 uCenter, uCamRight, uCamUp;
uniform float uBillboard;
out vec3 vWorld;
void main() {
  vec3 p = uCenter + (uCamRight * aCorner.x + uCamUp * aCorner.y) * uBillboard;
  vWorld = p;
  gl_Position = uViewProj * vec4(p, 1.0);
}`);

  const SUN_FS = V(COMMON + `
in vec3 vWorld;
out vec4 outColor;
uniform mat4 uViewProj;
uniform vec3 uCamPos, uCenter;
uniform float uRadius, uTime;
uniform mat3 uRot;
void main() {
  vec3 ro = uCamPos - uCenter;
  vec3 rd = normalize(vWorld - uCamPos);
  float b = dot(ro, rd), c = dot(ro, ro) - uRadius * uRadius;
  float h = b * b - c;
  if (h < 0.0) discard;
  float t = -b - sqrt(h);
  vec3 p = ro + rd * t;
  vec3 n = p / uRadius;
  vec4 clip = uViewProj * vec4(uCenter + p, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);

  float mu = max(dot(n, -rd), 0.0);
  vec3 q = transpose(uRot) * n;
  float g = fbm(q * 22.0 + vec3(0.0, 0.0, uTime * 0.08));
  float g2 = noise(q * 70.0 + uTime * 0.25);
  float spots = smoothstep(0.70, 0.78, fbm3(q * 6.0 + vec3(3.0, 0.0, uTime * 0.002))) * smoothstep(0.55, 0.15, abs(q.z));
  float limb = 0.32 + 0.68 * pow(mu, 0.55);
  vec3 col = mix(vec3(1.0, 0.45, 0.12), vec3(1.0, 0.86, 0.62), pow(mu, 0.7));
  col *= limb * (0.82 + 0.28 * g + 0.08 * g2) * (1.0 - 0.65 * spots);
  // 縁の彩層っぽい赤み
  col += vec3(1.0, 0.35, 0.1) * pow(1.0 - mu, 6.0) * 0.6;
  outColor = vec4(tonemap(col * 1.7), 1.0);
}`);

  const GLOW_VS = V(`
layout(location = 0) in vec2 aCorner;
uniform mat4 uViewProj;
uniform vec3 uCenter, uCamRight, uCamUp;
uniform float uSize;
out vec2 vUV;
void main() {
  vUV = aCorner * uSize;
  vec3 p = uCenter + (uCamRight * aCorner.x + uCamUp * aCorner.y) * uSize;
  gl_Position = uViewProj * vec4(p, 1.0);
}`);

  const GLOW_FS = V(COMMON + `
in vec2 vUV;
out vec4 outColor;
uniform float uSize, uRe, uTime;
void main() {
  float d = length(vUV);
  float r = d / uRe;
  float x = max(r - 1.0, 0.0);
  float g = 0.75 * exp(-x * 3.0) + 0.20 * exp(-x * 0.6) + 0.035 * exp(-x * 0.12);
  vec2 dir = vUV / max(d, 1e-9);
  float rays = pow(noise(vec3(dir * 7.0, uTime * 0.05)), 3.0) * 0.9 + pow(noise(vec3(dir * 19.0, 3.0 + uTime * 0.03)), 4.0) * 0.6;
  rays *= exp(-x * 0.35) * smoothstep(0.9, 1.4, r);
  vec3 col = vec3(1.0, 0.66, 0.34) * g + vec3(1.0, 0.85, 0.65) * rays * 0.22;
  col *= smoothstep(1.0, 0.7, d / uSize);
  outColor = vec4(1.0 - exp(-col), 1.0);
}`);

  const PLANET_FS = V(COMMON + `
in vec3 vWorld;
out vec4 outColor;
uniform mat4 uViewProj;
uniform vec3 uCamPos, uCenter, uRadii, uSunPos;
uniform mat3 uBody;
uniform int uType, uSelf, uRingType;
uniform float uSunRadius, uLight, uRingScale, uTime;
uniform vec4 uBodies[8];

float craters(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  float res = 0.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 cell = i + g;
    float q = length(g + hash3(cell) - f) / (0.18 + 0.3 * hash(cell + 11.3));
    float present = step(0.45, hash(cell + 4.7));
    res += present * (-0.22 * smoothstep(1.0, 0.6, q) + 0.16 * smoothstep(0.7, 1.0, q) * smoothstep(1.35, 1.0, q));
  }
  return res;
}

// n: 天体固定座標の単位ベクトル（z が北極）。戻り値はアルベド（線形）
vec3 surface(vec3 n, out float ocean, out vec3 night, out vec3 atmo, out float atmoK, out float wrap) {
  ocean = 0.0; night = vec3(0.0); atmo = vec3(0.0); atmoK = 0.0; wrap = 0.0;
  float lat = asin(clamp(n.z, -1.0, 1.0));

  if (uType == 0) { // Mercury
    float f = fbm(n * 3.0 + 1.3);
    vec3 c = mix(srgb(vec3(0.36, 0.34, 0.32)), srgb(vec3(0.66, 0.63, 0.59)), smoothstep(0.3, 0.7, f));
    c *= 1.0 + craters(n * 7.0) + 0.6 * craters(n * 17.0 + 5.0);
    c *= 0.9 + 0.2 * noise(n * 40.0);
    return c;
  }
  if (uType == 1) { // Venus（厚い雲）
    float w = fbm(n * vec3(2.0, 2.0, 4.0) + vec3(0.0, 0.0, uTime * 0.004));
    float v = fbm(n * vec3(2.5, 2.5, 7.0) + 2.0 * w);
    vec3 c = mix(srgb(vec3(0.96, 0.89, 0.70)), srgb(vec3(0.80, 0.66, 0.45)), clamp(v * 1.1 - 0.2, 0.0, 1.0));
    atmo = srgb(vec3(1.0, 0.86, 0.6)); atmoK = 0.6; wrap = 0.12;
    return c;
  }
  if (uType == 2) { // Earth
    float h = fbm(n * 1.7 + vec3(4.1, 2.3, 7.7)) * 0.75 + fbm(n * 5.5 + 1.3) * 0.25;
    float land = smoothstep(0.485, 0.50, h);
    float coast = smoothstep(0.42, 0.485, h) * (1.0 - land);
    vec3 water = mix(srgb(vec3(0.02, 0.07, 0.20)), srgb(vec3(0.05, 0.22, 0.38)), coast);
    float alat = abs(lat);
    float desert = exp(-pow((alat - 0.42) / 0.16, 2.0)) * smoothstep(0.42, 0.6, fbm(n * 3.0 + 9.0));
    vec3 ground = mix(srgb(vec3(0.13, 0.25, 0.09)), srgb(vec3(0.33, 0.38, 0.18)), smoothstep(0.4, 0.7, fbm(n * 6.0)));
    ground = mix(ground, srgb(vec3(0.74, 0.60, 0.40)), clamp(desert * 1.4, 0.0, 1.0));
    ground = mix(ground, srgb(vec3(0.42, 0.38, 0.32)), smoothstep(0.9, 1.1, alat));
    ground = mix(ground, srgb(vec3(0.45, 0.40, 0.34)), smoothstep(0.62, 0.72, h) * 0.6);
    vec3 c = mix(water, ground, land);
    float ice = smoothstep(1.17, 1.25, alat + 0.12 * (fbm(n * 4.0) - 0.5));
    c = mix(c, srgb(vec3(0.92, 0.95, 1.0)), ice);
    // 雲（ゆっくり流れる）
    float a = uTime * 0.03;
    vec3 q = vec3(cos(a) * n.x - sin(a) * n.y, sin(a) * n.x + cos(a) * n.y, n.z);
    vec3 warp = vec3(fbm3(q * 1.6), fbm3(q * 1.6 + 3.1), fbm3(q * 1.6 + 7.3));
    float cl = fbm(q * vec3(2.6, 2.6, 4.0) + 1.8 * warp);
    float cloud = smoothstep(0.5, 0.75, cl) * (0.75 + 0.25 * cos(lat * 6.0));
    ocean = (1.0 - land) * (1.0 - ice) * (1.0 - cloud);
    // 夜の街明かり
    float city = land * (1.0 - ice) * (1.0 - desert) * pow(noise(n * 90.0), 8.0) * smoothstep(0.45, 0.65, fbm(n * 5.0 + 2.0));
    night = srgb(vec3(1.0, 0.72, 0.38)) * city * 2.5 * (1.0 - cloud);
    c = mix(c, srgb(vec3(0.95, 0.96, 0.98)), cloud);
    atmo = srgb(vec3(0.35, 0.6, 1.0)); atmoK = 1.0; wrap = 0.06;
    return c;
  }
  if (uType == 3) { // Mars
    float f = fbm(n * 2.5 + 7.0);
    float g = fbm(n * 8.0);
    vec3 c = mix(srgb(vec3(0.78, 0.42, 0.22)), srgb(vec3(0.42, 0.22, 0.13)), smoothstep(0.48, 0.62, f));
    c = mix(c, srgb(vec3(0.86, 0.56, 0.33)), smoothstep(0.55, 0.75, g) * 0.4);
    c *= 1.0 + 0.5 * craters(n * 9.0);
    float cap = smoothstep(1.28, 1.36, abs(lat) + 0.08 * (g - 0.5));
    c = mix(c, srgb(vec3(0.95, 0.93, 0.9)), cap);
    atmo = srgb(vec3(0.95, 0.62, 0.45)); atmoK = 0.3; wrap = 0.03;
    return c;
  }
  if (uType == 4) { // Jupiter
    float t1 = fbm(n * vec3(3.0, 3.0, 14.0));
    float t2 = fbm(n * vec3(9.0, 9.0, 30.0) + 5.0);
    float y = lat + 0.035 * (t1 - 0.5) + 0.012 * (t2 - 0.5);
    float bands = smoothstep(-0.35, 0.35, sin(y * 15.0 + 0.6 * sin(y * 6.0)));
    vec3 zone = srgb(vec3(0.93, 0.88, 0.78)), belt = srgb(vec3(0.70, 0.50, 0.35));
    vec3 c = mix(belt, zone, bands);
    c = mix(c, srgb(vec3(0.83, 0.60, 0.40)), 0.35 * smoothstep(0.4, 0.8, noise1(y * 30.0)));
    c *= 0.9 + 0.2 * noise1(y * 120.0 + 10.0);
    c = mix(c, srgb(vec3(0.55, 0.52, 0.50)), smoothstep(0.9, 1.25, abs(lat)));
    // 大赤斑
    float lon = atan(n.y, n.x);
    float dl = mod(lon - 1.2 + 3.14159265, 6.2831853) - 3.14159265;
    float d = length(vec2(dl * cos(lat) / 0.20, (lat + 0.393) / 0.085)) + 0.15 * (t2 - 0.5);
    float spot = smoothstep(1.0, 0.55, d);
    c = mix(c, zone, smoothstep(1.3, 1.0, d) * (1.0 - spot) * 0.6);
    c = mix(c, srgb(vec3(0.76, 0.36, 0.22)), spot * 0.9);
    atmo = srgb(vec3(0.9, 0.8, 0.65)); atmoK = 0.25; wrap = 0.05;
    return c;
  }
  if (uType == 5) { // Saturn
    float t1 = fbm(n * vec3(3.0, 3.0, 16.0) + 2.0);
    float y = lat + 0.02 * (t1 - 0.5);
    vec3 c = mix(srgb(vec3(0.80, 0.68, 0.47)), srgb(vec3(0.92, 0.84, 0.64)), smoothstep(-0.6, 0.6, sin(y * 20.0 + 0.8 * sin(y * 7.0))));
    c *= 0.94 + 0.12 * noise1(y * 90.0);
    c = mix(c, srgb(vec3(0.62, 0.64, 0.62)), smoothstep(1.05, 1.4, abs(lat)) * 0.7);
    atmo = srgb(vec3(0.95, 0.85, 0.6)); atmoK = 0.2; wrap = 0.05;
    return c;
  }
  if (uType == 6) { // Uranus
    vec3 c = srgb(vec3(0.56, 0.86, 0.93));
    c *= 0.97 + 0.05 * sin(lat * 10.0 + 2.0 * fbm3(n * 3.0));
    c = mix(c, srgb(vec3(0.78, 0.93, 0.95)), smoothstep(0.9, 1.4, abs(lat)) * 0.4);
    atmo = srgb(vec3(0.6, 0.9, 1.0)); atmoK = 0.45; wrap = 0.08;
    return c;
  }
  // Neptune
  float t1 = fbm(n * vec3(3.0, 3.0, 12.0) + 4.0);
  float y = lat + 0.03 * (t1 - 0.5);
  vec3 c = mix(srgb(vec3(0.20, 0.33, 0.78)), srgb(vec3(0.30, 0.48, 0.92)), smoothstep(-0.5, 0.5, sin(y * 9.0)));
  float lon = atan(n.y, n.x);
  float dl = mod(lon + 0.8 + 3.14159265, 6.2831853) - 3.14159265;
  c = mix(c, srgb(vec3(0.10, 0.16, 0.45)), smoothstep(1.0, 0.5, length(vec2(dl * cos(lat) / 0.16, (lat + 0.35) / 0.07))) * 0.85);
  c = mix(c, vec3(0.9), smoothstep(0.64, 0.74, fbm(n * vec3(4.0, 4.0, 22.0) + 3.0)) * 0.7);
  atmo = srgb(vec3(0.45, 0.6, 1.0)); atmoK = 0.5; wrap = 0.08;
  return c;
}

void main() {
  mat3 inv = transpose(uBody);
  vec3 ro = inv * (uCamPos - uCenter);
  vec3 rd = inv * normalize(vWorld - uCamPos);
  float t = hitEllipsoid(ro, rd, uRadii);
  if (t < 0.0) discard;
  vec3 pl = ro + rd * t;
  vec3 N = normalize(uBody * (pl / (uRadii * uRadii)));
  vec3 sn = normalize(pl / uRadii);
  vec3 pw = uCenter + uBody * pl;
  vec4 clip = uViewProj * vec4(pw, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);

  vec3 toSun = uSunPos - pw;
  float dSun = length(toSun);
  vec3 L = toSun / dSun;
  vec3 Vv = normalize(uCamPos - pw);

  // 他の惑星による影（太陽の見かけの大きさから半影も付ける）
  float shadow = 1.0;
  for (int i = 0; i < 8; i++) {
    if (i == uSelf) continue;
    vec4 b = uBodies[i];
    vec3 oc = b.xyz - pw;
    float tt = dot(oc, L);
    if (tt <= 0.0 || tt > dSun) continue;
    float d = length(oc - L * tt);
    float pen = max(tt * uSunRadius / dSun, b.w * 0.02);
    shadow *= smoothstep(b.w - pen, b.w + pen, d);
  }
  // 環の影
  if (uRingType > 0) {
    vec3 Ll = inv * L;
    if (abs(Ll.z) > 1e-4) {
      float tt = -pl.z / Ll.z;
      if (tt > 0.0) {
        float r = length((pl + Ll * tt).xy) / uRingScale;
        shadow *= exp(-ringTau(uRingType, r, 0.0) / abs(Ll.z));
      }
    }
  }

  float ocean, atmoK, wrap;
  vec3 night, atmo;
  vec3 albedo = surface(sn, ocean, night, atmo, atmoK, wrap);

  float NdL = dot(N, L);
  float diff = clamp((NdL + wrap) / (1.0 + wrap), 0.0, 1.0);
  vec3 direct = vec3(uLight * shadow);
  vec3 col = albedo * diff * direct;

  float mu = max(dot(N, Vv), 0.0);
  if (uType >= 4) col *= mix(0.55, 1.0, pow(mu, 0.35)); // ガス惑星の周辺減光
  if (ocean > 0.0) {
    vec3 H = normalize(L + Vv);
    col += ocean * srgb(vec3(0.85, 0.9, 1.0)) * pow(max(dot(N, H), 0.0), 220.0) * 0.45 * direct * step(0.0, NdL);
  }
  float rim = pow(1.0 - mu, 4.0);
  col += atmo * atmoK * rim * smoothstep(-0.15, 0.5, NdL) * uLight * shadow;
  col += night * smoothstep(0.05, -0.2, NdL);
  col += albedo * 0.004;
  outColor = vec4(tonemap(col * 1.35), 1.0);
}`);

  /* ---- 環 ---- */
  const RING_VS = V(`
layout(location = 0) in vec2 aCorner;
uniform mat4 uViewProj;
uniform vec3 uCenter, uE1, uE2;
uniform float uOuterKm, uScale;
out vec3 vWorld;
out vec2 vLocal;
void main() {
  vLocal = aCorner * uOuterKm;
  vec3 p = uCenter + (uE1 * aCorner.x + uE2 * aCorner.y) * uOuterKm * uScale;
  vWorld = p;
  gl_Position = uViewProj * vec4(p, 1.0);
}`);

  const RING_FS = V(COMMON + `
in vec3 vWorld;
in vec2 vLocal;
out vec4 outColor;
uniform vec3 uCamPos, uSunPos, uCenter, uN, uRadii;
uniform mat3 uBody;
uniform int uRingType;
uniform float uLight;
void main() {
  float r = length(vLocal);
  float fw = fwidth(r);
  float tau = ringTau(uRingType, r, fw);
  if (tau < 0.0005) discard;
  vec3 Vv = normalize(uCamPos - vWorld);
  vec3 L = normalize(uSunPos - vWorld);
  float sv = dot(Vv, uN), sl = dot(L, uN);
  float muV = max(abs(sv), 0.015), muL = max(abs(sl), 0.015);
  float alpha = 1.0 - exp(-tau / muV);

  // 惑星の影
  mat3 inv = transpose(uBody);
  vec3 o = (inv * (vWorld - uCenter)) / uRadii;
  vec3 d = (inv * L) / uRadii;
  float tc = -dot(o, d) / dot(d, d);
  float shadow = tc > 0.0 ? smoothstep(0.97, 1.03, length(o + d * tc)) : 1.0;

  // 単散乱の近似：太陽に照らされた面と、裏側（透過光）で明るさを変える
  float I;
  if (sv * sl > 0.0) I = 2.0 * muL / (muL + muV) * (1.0 - exp(-tau * (1.0 / muL + 1.0 / muV)));
  else I = 1.2 * tau * exp(-tau * 0.5 * (1.0 / muL + 1.0 / muV)) * muL / (muL + muV);
  vec3 c = ringColor(uRingType, r) * (I * shadow * uLight * 1.4 + 0.003 * tau);
  vec3 toned = tonemap(c / max(alpha, 1e-3));
  outColor = vec4(toned * alpha, alpha);
}`);

  /* ---- 公転軌道（惑星の後ろほど薄くなる尾） ---- */
  const ORBIT_VS = V(`
layout(location = 0) in vec3 aPos;
layout(location = 1) in float aTrail;
uniform mat4 uViewProj;
uniform float uAlpha;
out float vA;
void main() {
  gl_Position = uViewProj * vec4(aPos, 1.0);
  vA = uAlpha * (0.22 + 0.78 * exp(-aTrail * 7.0));
}`);

  const ORBIT_FS = V(`
precision highp float;
in float vA;
uniform vec3 uColor;
out vec4 outColor;
void main() { outColor = vec4(uColor * vA, 1.0); }`);

  /* ---- 遠くて数ピクセルにしか見えない惑星の位置を示す淡い光点 ---- */
  const MARKER_VS = V(`
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aCol;
uniform mat4 uViewProj;
uniform float uSize;
out vec4 vCol;
void main() { gl_Position = uViewProj * vec4(aPos, 1.0); gl_PointSize = uSize; vCol = aCol; }`);

  const MARKER_FS = V(`
precision highp float;
in vec4 vCol;
out vec4 outColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  float a = exp(-d * 14.0) * 0.9 + exp(-d * 3.5) * 0.22;
  outColor = vec4(vCol.rgb * a * vCol.a, 1.0);
}`);

  /* =========================================================================
   * WebGL の準備
   * ======================================================================= */
  function compile(type, src, label) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(`シェーダーのコンパイルに失敗しました (${label})\n` + gl.getShaderInfoLog(s));
    }
    return s;
  }

  function program(vs, fs, label) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs, label + ' VS'));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs, label + ' FS'));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`シェーダーのリンクに失敗しました (${label})\n` + gl.getProgramInfoLog(p));
    }
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
    }
    // 最適化で消えた uniform は null を返す
    return { p, u: new Proxy(u, { get: (t, k) => (k in t ? t[k] : null) }) };
  }

  let progs;
  try {
    progs = {
      bg: program(BG_VS, BG_FS, 'background'),
      star: program(STAR_VS, STAR_FS, 'stars'),
      sun: program(IMPOSTOR_VS, SUN_FS, 'sun'),
      glow: program(GLOW_VS, GLOW_FS, 'glow'),
      planet: program(IMPOSTOR_VS, PLANET_FS, 'planet'),
      ring: program(RING_VS, RING_FS, 'ring'),
      orbit: program(ORBIT_VS, ORBIT_FS, 'orbit'),
      marker: program(MARKER_VS, MARKER_FS, 'marker'),
    };
  } catch (e) {
    showError(e.message);
    return;
  }

  function makeVAO(setup) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    setup();
    gl.bindVertexArray(null);
    return vao;
  }

  function staticBuffer(data) {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return b;
  }

  const quadVAO = makeVAO(() => {
    staticBuffer(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  });

  const triVAO = makeVAO(() => {
    staticBuffer(new Float32Array([-1, -1, 3, -1, -1, 3]));
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  });

  /* ---- 恒星（天の川の方向に少し多く集める。位置はランダム） ---- */
  const GP = A.raDecToEcliptic(192.85948, 27.12825); // 銀河北極
  let GC = A.raDecToEcliptic(266.40500, -28.93617); // 銀河中心
  GC = norm(sub(GC, GP.map((v) => v * dot(GC, GP))));
  const GY = cross(GP, GC);
  const LMC = A.raDecToEcliptic(80.89, -69.76);
  const SMC = A.raDecToEcliptic(13.19, -72.83);

  const STAR_COUNT = 9000;
  const starVAO = makeVAO(() => {
    let seed = 12345;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
    const palette = [[0.62, 0.72, 1.0], [0.8, 0.86, 1.0], [1, 1, 1], [1, 0.95, 0.85], [1, 0.85, 0.66], [1, 0.7, 0.5]];
    const weights = [0.08, 0.17, 0.25, 0.22, 0.18, 0.10];
    const data = new Float32Array(STAR_COUNT * 7);
    for (let i = 0; i < STAR_COUNT; i++) {
      let d;
      if (rand() < 0.45) {
        const l = rand() * 2 * Math.PI, b = gauss() * 0.16;
        const cb = Math.cos(b);
        d = [0, 1, 2].map((k) => cb * Math.cos(l) * GC[k] + cb * Math.sin(l) * GY[k] + Math.sin(b) * GP[k]);
      } else {
        const z = rand() * 2 - 1, a = rand() * 2 * Math.PI, r = Math.sqrt(1 - z * z);
        d = [r * Math.cos(a), r * Math.sin(a), z];
      }
      const m = Math.pow(rand(), 4.2);
      let pick = rand(), ci = 0;
      while (ci < weights.length - 1 && pick > weights[ci]) { pick -= weights[ci]; ci++; }
      const bright = 0.1 + 1.7 * m;
      const c = palette[ci];
      data.set([d[0], d[1], d[2], c[0] * bright, c[1] * bright, c[2] * bright, 1.3 + 3.2 * m], i * 7);
    }
    staticBuffer(data);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
  });

  /* ---- 公転軌道の頂点（毎フレーム更新） ---- */
  const ORB_N = 512;
  const orbitData = new Float32Array(NP * (ORB_N + 1) * 4);
  const orbitBuf = gl.createBuffer();
  const orbitVAO = makeVAO(() => {
    gl.bindBuffer(gl.ARRAY_BUFFER, orbitBuf);
    gl.bufferData(gl.ARRAY_BUFFER, orbitData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
  });

  const markerData = new Float32Array(NP * 7);
  const markerBuf = gl.createBuffer();
  const markerVAO = makeVAO(() => {
    gl.bindBuffer(gl.ARRAY_BUFFER, markerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, markerData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
  });

  const planetColors = PL.map((p) => hexToRgb(p.color));

  /* =========================================================================
   * 状態
   * ======================================================================= */
  const JD_MIN = A.jdFromCalendar(-2999, 1, 1);   // 紀元前3000年1月1日
  const JD_MAX = A.jdFromCalendar(3000, 12, 31);  // 西暦3000年12月31日

  const S = {
    jd: A.jdNow(),
    live: true,        // 現在時刻に追従中
    playing: false,
    rate: 1,           // 日 / 秒
    visDays: 0,        // 自転・雲などの見た目用の時計（高速再生でもチラつかないよう 1日/秒 を上限に進める）
    scale: 300,        // 惑星の拡大倍率
  };
  S.visDays = S.jd;

  const cam = {
    az: -Math.PI / 2,
    el: 66 * DEG,
    dist: 200,
    distGoal: 60,
    target: [0, 0, 0],
    follow: -1,        // -1: 太陽, 0〜7: 惑星, null: 自由移動
    free: [0, 0, 0],
    transFrom: [0, 0, 0],
    transT: 1,
  };

  // 毎フレーム計算する天体の情報
  const bodies = [];
  for (let i = 0; i <= NP; i++) bodies.push({ pos: [0, 0, 0], rel: [0, 0, 0], rDisp: 0, rDraw: 0, screen: null, pr: 0, hoverR: 0 });
  let orbitsNow = [];

  const sunScale = () => Math.min(S.scale, SUN_SCALE_MAX);
  const displayRadius = (i) => (i === SUN_IDX ? A.SUN.radiusKm * sunScale() : PL[i].radiusKm * S.scale) / A.AU_KM;

  /**
   * 惑星を照らす光の強さ。実際は距離の2乗に反比例するが、それだと海王星が地球の 1/900 の明るさになり
   * 見えなくなるため、表示用にゆるやかに弱める。
   */
  const lightAt = (pos) => 2.0 * Math.pow(len(pos), -0.3);

  function fitDistance() {
    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    return 38 / (Math.tan(FOV / 2) * Math.min(1, aspect));
  }

  function viewDistanceFor(i) {
    if (i === SUN_IDX || i < 0) return fitDistance();
    const p = PL[i];
    const extent = p.ring === 1 ? RING_OUTER_KM[1] / p.radiusKm : p.ring ? 1.6 : 1;
    return Math.max(displayRadius(i) * extent * 7, 2e-4);
  }

  function focus(i) {
    cam.transFrom = cam.target.slice();
    cam.transT = 0;
    cam.follow = i === SUN_IDX ? -1 : i;
    cam.distGoal = viewDistanceFor(i === -1 ? SUN_IDX : i);
    updateBodyList();
  }

  function minDistance() {
    if (cam.follow === null) return 1e-5;
    const i = cam.follow < 0 ? SUN_IDX : cam.follow;
    return Math.max(bodies[i].rDraw * 1.8, 1e-5);
  }

  /* =========================================================================
   * 毎フレームの更新
   * ======================================================================= */
  function updatePositions() {
    const T = A.centuriesTT(S.jd);
    orbitsNow = PL.map((p) => A.orbitAt(p, T));
    for (let i = 0; i < NP; i++) A.pointOnOrbit(orbitsNow[i], orbitsNow[i].E, bodies[i].pos, 0);
    bodies[SUN_IDX].pos = [0, 0, 0];
  }

  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function updateCamera(dt) {
    const desired = cam.follow === null ? cam.free : cam.follow < 0 ? [0, 0, 0] : bodies[cam.follow].pos;
    if (cam.transT < 1) {
      cam.transT = Math.min(1, cam.transT + dt / 1.1);
      cam.target = lerp3(cam.transFrom, desired, ease(cam.transT));
    } else {
      cam.target = desired.slice();
    }
    cam.distGoal = clamp(cam.distGoal, minDistance(), 400);
    const k = 1 - Math.exp(-dt * 7);
    cam.dist = Math.exp(Math.log(cam.dist) + (Math.log(cam.distGoal) - Math.log(cam.dist)) * k);
  }

  let dpr = 1;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(canvas.clientWidth * dpr), h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  function render(realTime) {
    resize();
    const W = canvas.width, H = canvas.height;
    const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
    gl.viewport(0, 0, W, H);
    const tanH = Math.tan(FOV / 2);

    // カメラ（注視点を原点とした相対座標）
    const ce = Math.cos(cam.el), se = Math.sin(cam.el);
    const eye = [cam.dist * ce * Math.cos(cam.az), cam.dist * ce * Math.sin(cam.az), cam.dist * se];
    const P = perspective(FOV, W / H, cam.dist * 0.002, cam.dist * 4 + 120);
    const Vm = lookAt(eye, [0, 0, 0], [0, 0, 1]);
    const VP = mul(P, Vm);
    const Vr = Vm.slice(); Vr[12] = Vr[13] = Vr[14] = 0;
    const VPr = mul(P, Vr);
    const right = [Vm[0], Vm[4], Vm[8]], up = [Vm[1], Vm[5], Vm[9]];
    const T = cam.target;
    const worldPerPx = (d) => (2 * d * tanH) / H;
    const minPx = 1.6 * Math.max(1, dpr * 0.8);

    // 天体の表示サイズ・画面上の位置
    for (let i = 0; i <= NP; i++) {
      const b = bodies[i];
      b.rel = sub(b.pos, T);
      b.dCam = len(sub(b.rel, eye));
      b.rDisp = displayRadius(i);
      // 1ピクセルより小さくなる場合だけ、見えるように最小サイズにする
      b.rDraw = Math.max(b.rDisp, worldPerPx(b.dCam) * (i === SUN_IDX ? 2.5 : minPx));
      const x = VP[0] * b.rel[0] + VP[4] * b.rel[1] + VP[8] * b.rel[2] + VP[12];
      const y = VP[1] * b.rel[0] + VP[5] * b.rel[1] + VP[9] * b.rel[2] + VP[13];
      const w = VP[3] * b.rel[0] + VP[7] * b.rel[1] + VP[11] * b.rel[2] + VP[15];
      b.screen = w > 0 ? [(x / w * 0.5 + 0.5) * cssW, (0.5 - y / w * 0.5) * cssH] : null;
      b.pr = (b.rDraw / (2 * b.dCam * tanH)) * cssH;
      const ringExtent = i < NP && PL[i].ring === 1 ? RING_OUTER_KM[1] / PL[i].radiusKm : 1;
      b.hoverR = b.pr * ringExtent;
    }

    const sunB = bodies[SUN_IDX];
    const sunRel = sunB.rel;
    const visTime = S.visDays % 1000;
    const realSec = (realTime / 1000) % 1000;

    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // 1) 背景
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    let pr = progs.bg;
    gl.useProgram(pr.p);
    gl.uniformMatrix4fv(pr.u.uInvVP, false, invert(VPr));
    gl.uniform3fv(pr.u.uGP, GP);
    gl.uniform3fv(pr.u.uGC, GC);
    gl.uniform3fv(pr.u.uLMC, LMC);
    gl.uniform3fv(pr.u.uSMC, SMC);
    gl.bindVertexArray(triVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 2) 恒星
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    pr = progs.star;
    gl.useProgram(pr.p);
    gl.uniformMatrix4fv(pr.u.uVP, false, VPr);
    gl.uniform1f(pr.u.uDpr, dpr);
    gl.bindVertexArray(starVAO);
    gl.drawArrays(gl.POINTS, 0, STAR_COUNT);

    // 3) 太陽と惑星（不透明）
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.bindVertexArray(quadVAO);
    const billboard = (r, d) => (r / Math.sqrt(Math.max(1 - (r / d) * (r / d), 0.0025))) * 1.08;

    if (sunB.dCam > sunB.rDraw * 1.02) {
      pr = progs.sun;
      gl.useProgram(pr.p);
      gl.uniformMatrix4fv(pr.u.uViewProj, false, VP);
      gl.uniform3fv(pr.u.uCamPos, eye);
      gl.uniform3fv(pr.u.uCenter, sunRel);
      gl.uniform3fv(pr.u.uCamRight, right);
      gl.uniform3fv(pr.u.uCamUp, up);
      gl.uniform1f(pr.u.uBillboard, billboard(sunB.rDraw, sunB.dCam));
      gl.uniform1f(pr.u.uRadius, sunB.rDraw);
      gl.uniform1f(pr.u.uTime, realSec);
      gl.uniformMatrix3fv(pr.u.uRot, false, bodyBasis(A.SUN.poleEcl, 2 * Math.PI * ((S.visDays / A.SUN.rotation) % 1)).mat);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    const bodiesU = new Float32Array(NP * 4);
    for (let i = 0; i < NP; i++) bodiesU.set([...bodies[i].rel, bodies[i].rDisp], i * 4);

    pr = progs.planet;
    gl.useProgram(pr.p);
    gl.uniformMatrix4fv(pr.u.uViewProj, false, VP);
    gl.uniform3fv(pr.u.uCamPos, eye);
    gl.uniform3fv(pr.u.uCamRight, right);
    gl.uniform3fv(pr.u.uCamUp, up);
    gl.uniform3fv(pr.u.uSunPos, sunRel);
    gl.uniform1f(pr.u.uSunRadius, sunB.rDisp);
    gl.uniform1f(pr.u.uTime, visTime);
    gl.uniform4fv(pr.u.uBodies, bodiesU);
    const bases = [];
    for (let i = 0; i < NP; i++) {
      const p = PL[i], b = bodies[i];
      bases[i] = bodyBasis(p.poleEcl, 2 * Math.PI * ((S.visDays / p.rotation) % 1));
      if (b.dCam < b.rDraw * 1.02) continue; // カメラが惑星の中に入っている
      const polar = b.rDraw * (1 - p.flattening);
      gl.uniform3fv(pr.u.uCenter, b.rel);
      gl.uniform1f(pr.u.uBillboard, billboard(b.rDraw, b.dCam));
      gl.uniformMatrix3fv(pr.u.uBody, false, bases[i].mat);
      gl.uniform3f(pr.u.uRadii, b.rDraw, b.rDraw, polar);
      gl.uniform1i(pr.u.uType, i);
      gl.uniform1i(pr.u.uSelf, i);
      gl.uniform1i(pr.u.uRingType, p.ring);
      gl.uniform1f(pr.u.uRingScale, b.rDraw / p.radiusKm);
      gl.uniform1f(pr.u.uLight, lightAt(b.pos));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // 4) 公転軌道（加算合成・深度は書き込まない）
    for (let i = 0; i < NP; i++) {
      const o = orbitsNow[i];
      const tmp = [0, 0, 0];
      for (let k = 0; k <= ORB_N; k++) {
        A.pointOnOrbit(o, o.E - (2 * Math.PI * k) / ORB_N, tmp, 0);
        const j = (i * (ORB_N + 1) + k) * 4;
        orbitData[j] = tmp[0] - T[0];
        orbitData[j + 1] = tmp[1] - T[1];
        orbitData[j + 2] = tmp[2] - T[2];
        orbitData[j + 3] = k / ORB_N;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, orbitBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, orbitData);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    pr = progs.orbit;
    gl.useProgram(pr.p);
    gl.uniformMatrix4fv(pr.u.uViewProj, false, VP);
    gl.bindVertexArray(orbitVAO);
    for (let i = 0; i < NP; i++) {
      const hl = i === hovered || i === cam.follow;
      const c = planetColors[i];
      gl.uniform3f(pr.u.uColor, c[0] * 0.75 + 0.2, c[1] * 0.75 + 0.2, c[2] * 0.75 + 0.2);
      gl.uniform1f(pr.u.uAlpha, hl ? 0.95 : 0.5);
      gl.drawArrays(gl.LINE_STRIP, i * (ORB_N + 1), ORB_N + 1);
    }

    // 4b) 小さすぎる惑星の位置を示す光点（惑星が数ピクセル以上に見えるときは消える）
    for (let i = 0; i < NP; i++) {
      const b = bodies[i], c = planetColors[i];
      const fade = clamp(1 - (b.pr - 1.5) / 5, 0, 1);
      markerData.set([b.rel[0], b.rel[1], b.rel[2], c[0], c[1], c[2], fade * (i === hovered ? 1.4 : 1)], i * 7);
    }
    gl.disable(gl.DEPTH_TEST);
    pr = progs.marker;
    gl.useProgram(pr.p);
    gl.uniformMatrix4fv(pr.u.uViewProj, false, VP);
    gl.uniform1f(pr.u.uSize, 18 * dpr);
    gl.bindBuffer(gl.ARRAY_BUFFER, markerBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, markerData);
    gl.bindVertexArray(markerVAO);
    gl.drawArrays(gl.POINTS, 0, NP);
    gl.enable(gl.DEPTH_TEST);

    // 5) 環（半透明）
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(quadVAO);
    pr = progs.ring;
    gl.useProgram(pr.p);
    gl.uniformMatrix4fv(pr.u.uViewProj, false, VP);
    gl.uniform3fv(pr.u.uCamPos, eye);
    gl.uniform3fv(pr.u.uSunPos, sunRel);
    for (let i = 0; i < NP; i++) {
      const p = PL[i], b = bodies[i];
      if (!p.ring) continue;
      gl.uniform3fv(pr.u.uCenter, b.rel);
      gl.uniform3fv(pr.u.uE1, bases[i].e1);
      gl.uniform3fv(pr.u.uE2, bases[i].e2);
      gl.uniform3fv(pr.u.uN, p.poleEcl);
      gl.uniform1f(pr.u.uOuterKm, RING_OUTER_KM[p.ring]);
      gl.uniform1f(pr.u.uScale, b.rDraw / p.radiusKm);
      gl.uniformMatrix3fv(pr.u.uBody, false, bases[i].mat);
      gl.uniform3f(pr.u.uRadii, b.rDraw, b.rDraw, b.rDraw * (1 - p.flattening));
      gl.uniform1i(pr.u.uRingType, p.ring);
      gl.uniform1f(pr.u.uLight, lightAt(b.pos));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // 6) 太陽の光芒（加算）
    gl.blendFunc(gl.ONE, gl.ONE);
    pr = progs.glow;
    gl.useProgram(pr.p);
    const re = Math.max(sunB.rDisp, worldPerPx(sunB.dCam) * 3.5);
    gl.uniformMatrix4fv(pr.u.uViewProj, false, VP);
    gl.uniform3fv(pr.u.uCenter, sunRel);
    gl.uniform3fv(pr.u.uCamRight, right);
    gl.uniform3fv(pr.u.uCamUp, up);
    gl.uniform1f(pr.u.uSize, re * 18);
    gl.uniform1f(pr.u.uRe, re);
    gl.uniform1f(pr.u.uTime, realSec);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  /* =========================================================================
   * 日付の表示・UI
   * ======================================================================= */
  const eraYear = (y) => (y <= 0 ? ['紀元前', 1 - y] : ['西暦', y]);
  // 月・日は2桁にそろえる（高速再生中に桁数が変わって表示がチラつかないように）
  const pad2 = (n) => String(n).padStart(2, '0');
  function dateText(jd) {
    const c = A.calendarFromJD(jd);
    const [era, y] = eraYear(c.year);
    return `${era}${y}年${pad2(c.month)}月${pad2(c.day)}日`;
  }

  const dateMain = $('dateMain'), dateSub = $('dateSub');
  const tl = $('timeline'), tlFill = tl.querySelector('.fill'), tlThumb = tl.querySelector('.thumb');
  const tlTip = tl.querySelector('.tip'), tlNow = tl.querySelector('.nowMark'), tlTicks = tl.querySelector('.ticks');
  const playBtn = $('play');
  const label = $('label'), labelName = label.querySelector('.name'), labelMeta = label.querySelector('.meta');
  let lastMain = '', lastSub = '';

  const jdToFrac = (jd) => (jd - JD_MIN) / (JD_MAX - JD_MIN);

  // 目盛り
  (function buildTicks() {
    const major = [[-2999, '紀元前3000年'], [-1499, '紀元前1500年'], [1, '西暦1年'], [1500, '西暦1500年']];
    major.forEach(([y, text], k) => {
      const el = document.createElement('div');
      el.className = 'tick' + (k === 0 ? ' first' : '');
      el.style.left = (jdToFrac(A.jdFromCalendar(y, 1, 1)) * 100) + '%';
      el.textContent = text;
      tlTicks.appendChild(el);
    });
    const last = document.createElement('div');
    last.className = 'tick last';
    last.style.left = '100%';
    last.textContent = '西暦3000年';
    tlTicks.appendChild(last);
    for (let y = -2500; y <= 2500; y += 500) {
      const m = document.createElement('div');
      m.className = 'minor';
      m.style.left = (jdToFrac(A.jdFromCalendar(y === 0 ? 1 : y, 1, 1)) * 100) + '%';
      tl.querySelector('.track').appendChild(m);
    }
  })();

  function speedLabel() {
    return S.rate === 1 ? '1日/秒' : S.rate === 365.25 ? '1年/秒' : '100年/秒';
  }

  function updateUI() {
    const c = A.calendarFromJD(S.jd);
    const [era, y] = eraYear(c.year);
    const main = `<span class="era">${era}</span>${y}<span class="u">年</span>${pad2(c.month)}<span class="u">月</span>${pad2(c.day)}<span class="u">日</span>`;
    if (main !== lastMain) { dateMain.innerHTML = main; lastMain = main; }

    const mins = Math.floor(c.fraction * 1440 + 1e-6);
    const hhmm = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')} UT`;
    const badge = S.live ? '<span class="badge">LIVE</span>' : S.playing ? `<span class="badge play">▶ ${speedLabel()}</span>` : '';
    const sub = `<span>${hhmm}</span><span>${c.gregorian ? 'グレゴリオ暦' : 'ユリウス暦'}</span>${badge}`;
    if (sub !== lastSub) { dateSub.innerHTML = sub; lastSub = sub; }

    const f = jdToFrac(S.jd) * 100;
    tlFill.style.width = f + '%';
    tlThumb.style.left = f + '%';
    tlNow.style.left = (jdToFrac(A.jdNow()) * 100) + '%';
    playBtn.classList.toggle('playing', S.playing);

    // ホバー中（なければ追尾中）の天体の名前
    const show = hovered >= 0 ? hovered : cam.follow !== null && cam.follow >= 0 ? cam.follow : -1;
    const b = show >= 0 ? bodies[show] : null;
    if (b && b.screen) {
      const name = show === SUN_IDX ? A.SUN.name : PL[show].name;
      if (labelName.textContent !== name) labelName.textContent = name;
      labelMeta.textContent = show === SUN_IDX ? '' : `${len(b.pos).toFixed(3)} au`;
      label.style.left = b.screen[0] + 'px';
      label.style.top = (b.screen[1] - Math.max(b.hoverR, 3) - 6) + 'px';
      label.classList.add('show');
    } else {
      label.classList.remove('show');
    }
  }

  function setJD(jd) {
    S.live = false;
    S.jd = clamp(jd, JD_MIN, JD_MAX);
  }

  function stepDays(n) { setJD((S.live ? A.jdNow() : S.jd) + n); }
  function stepYears(n) {
    const c = A.calendarFromJD(S.jd);
    const y = c.year + n;
    const d = Math.min(c.day, A.daysInMonth(y, c.month));
    setJD(A.jdFromCalendar(y, c.month, d + c.fraction));
  }

  function togglePlay() {
    if (S.playing) { S.playing = false; return; }
    S.live = false;
    if (S.jd >= JD_MAX) S.jd = JD_MIN;
    S.playing = true;
  }

  function goNow() { S.live = true; S.playing = false; }

  playBtn.addEventListener('click', togglePlay);
  $('nowBtn').addEventListener('click', goNow);
  $('fitBtn').addEventListener('click', () => focus(SUN_IDX));

  document.querySelectorAll('#speeds button').forEach((btn) => {
    btn.addEventListener('click', () => {
      S.rate = parseFloat(btn.dataset.rate);
      document.querySelectorAll('#speeds button').forEach((b) => b.classList.toggle('on', b === btn));
    });
  });

  // 惑星の大きさ（対数スライダー: ×1〜×2000）
  const scaleInput = $('scale'), scaleOut = $('scaleOut');
  const SCALE_MAX = 2000;
  const fmtScale = (s) => (s < 10 ? s.toFixed(1).replace(/\.0$/, '') : String(Math.round(s)));
  function setScale(s) {
    S.scale = s;
    scaleOut.textContent = s <= 1.001 ? '実寸' : `×${fmtScale(s)}（太陽 ×${fmtScale(sunScale())}）`;
  }
  scaleInput.value = Math.round((Math.log10(S.scale) / Math.log10(SCALE_MAX)) * 1000);
  setScale(S.scale);
  scaleInput.addEventListener('input', () => {
    setScale(Math.pow(10, (scaleInput.value / 1000) * Math.log10(SCALE_MAX)));
    if (cam.follow !== null && cam.follow >= 0) cam.distGoal = viewDistanceFor(cam.follow);
  });

  // タイムライン（スライドバー）
  function fracAt(clientX) {
    const r = tl.getBoundingClientRect();
    return clamp((clientX - r.left) / r.width, 0, 1);
  }
  const jdAtFrac = (f) => Math.floor(JD_MIN + f * (JD_MAX - JD_MIN) - 0.5) + 0.5; // その日の 0時 UT
  let tlDragging = false;
  tl.addEventListener('pointerdown', (e) => {
    tlDragging = true;
    tl.classList.add('drag');
    tl.setPointerCapture(e.pointerId);
    setJD(jdAtFrac(fracAt(e.clientX)));
  });
  tl.addEventListener('pointermove', (e) => {
    const f = fracAt(e.clientX);
    tlTip.style.left = (f * 100) + '%';
    tlTip.textContent = dateText(jdAtFrac(f));
    if (tlDragging) setJD(jdAtFrac(f));
  });
  const endTl = () => { tlDragging = false; tl.classList.remove('drag'); };
  tl.addEventListener('pointerup', endTl);
  tl.addEventListener('pointercancel', endTl);

  // 日付の直接入力
  const form = $('dateForm');
  $('dateBtn').addEventListener('click', () => {
    if (!form.classList.contains('hidden')) { form.classList.add('hidden'); return; }
    const c = A.calendarFromJD(S.jd);
    $('fEra').value = c.year <= 0 ? 'bc' : 'ad';
    $('fYear').value = c.year <= 0 ? 1 - c.year : c.year;
    $('fMonth').value = c.month;
    $('fDay').value = c.day;
    form.classList.remove('hidden');
    $('fYear').focus();
    $('fYear').select();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const yy = clamp(parseInt($('fYear').value, 10) || 1, 1, 3000);
    const y = $('fEra').value === 'bc' ? 1 - yy : yy;
    const m = clamp(parseInt($('fMonth').value, 10) || 1, 1, 12);
    const d = clamp(parseInt($('fDay').value, 10) || 1, 1, A.daysInMonth(y, m));
    setJD(A.jdFromCalendar(y, m, d));
    form.classList.add('hidden');
  });

  // 天体リスト
  const listEl = $('bodies');
  const listButtons = [];
  [SUN_IDX, ...PL.keys()].forEach((i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const color = i === SUN_IDX ? '#ffcf7a' : PL[i].color;
    const name = i === SUN_IDX ? A.SUN.name : PL[i].name;
    const jp = i === SUN_IDX ? A.SUN.jp : PL[i].jp;
    btn.innerHTML = `<span class="dot" style="background:${color};color:${color}"></span>${name}<span class="jp">${jp}</span>`;
    btn.addEventListener('click', () => focus(i));
    btn.addEventListener('mouseenter', () => { listHover = i; });
    btn.addEventListener('mouseleave', () => { listHover = -1; });
    listEl.appendChild(btn);
    listButtons.push([i, btn]);
  });
  let listHover = -1;
  function updateBodyList() {
    for (const [i, btn] of listButtons) {
      btn.classList.toggle('on', (i === SUN_IDX && cam.follow === -1) || i === cam.follow);
    }
  }
  updateBodyList();

  // 操作ヒントは少したったら消す
  const hint = $('hint');
  const fadeHint = () => hint.classList.add('fade');
  setTimeout(fadeHint, 14000);

  /* =========================================================================
   * マウス・タッチ操作
   * ======================================================================= */
  let hovered = -1;
  let mouse = null;
  const pointers = new Map();
  let drag = null;
  let pinchDist = 0;

  function pick(mx, my) {
    let best = -1, bestScore = Infinity;
    for (let i = 0; i <= NP; i++) {
      const b = bodies[i];
      if (!b.screen) continue;
      const d = Math.hypot(b.screen[0] - mx, b.screen[1] - my);
      const reach = Math.max(b.hoverR * 1.1, b.pr + 16);
      if (d < reach) {
        const score = d - b.pr;
        if (score < bestScore) { bestScore = score; best = i; }
      }
    }
    return best;
  }

  function panBy(dx, dy) {
    if (cam.follow !== null) { cam.free = cam.target.slice(); cam.follow = null; cam.transT = 1; updateBodyList(); }
    const k = (2 * cam.dist * Math.tan(FOV / 2)) / canvas.clientHeight;
    const rx = -Math.sin(cam.az), ry = Math.cos(cam.az);
    const fx = -Math.cos(cam.az), fy = -Math.sin(cam.az);
    const ky = k / Math.max(Math.sin(cam.el), 0.3);
    cam.free = [cam.free[0] - rx * dx * k + fx * dy * ky, cam.free[1] - ry * dx * k + fy * dy * ky, cam.free[2]];
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, pan: e.button === 2 || e.button === 1 || e.shiftKey };
      canvas.classList.add('dragging');
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      if (drag) drag.moved = true;
    }
    fadeHint();
  });
  canvas.addEventListener('pointermove', (e) => {
    mouse = [e.clientX, e.clientY];
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0) cam.distGoal *= pinchDist / d;
      pinchDist = d;
      return;
    }
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) drag.moved = true;
    if (!drag.moved) return;
    if (drag.pan) panBy(dx, dy);
    else {
      cam.az -= dx * 0.0055;
      cam.el = clamp(cam.el + dy * 0.0045, 4 * DEG, 89.5 * DEG);
    }
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) {
      if (drag && !drag.moved && e.type === 'pointerup') {
        const i = pick(e.clientX, e.clientY);
        if (i >= 0) focus(i);
      }
      drag = null;
      canvas.classList.remove('dragging');
    }
    if (pointers.size < 2) pinchDist = 0;
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', () => { mouse = null; });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    cam.distGoal *= Math.exp(dy * 0.0012);
    fadeHint();
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) {
      if (e.key === 'Escape') form.classList.add('hidden');
      return;
    }
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? stepYears(1) : stepDays(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? stepYears(-1) : stepDays(-1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); stepYears(100); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); stepYears(-100); }
    else if (e.key === 'l' || e.key === 'L' || e.key === 'Home') goNow();
    else if (e.key === 'Escape') form.classList.add('hidden');
    else if (e.key >= '0' && e.key <= '8') focus(e.key === '0' ? SUN_IDX : parseInt(e.key, 10) - 1);
  });

  /* =========================================================================
   * メインループ
   * ======================================================================= */
  let lastTs = null;
  cam.distGoal = fitDistance();
  cam.dist = cam.distGoal * 3.2; // 起動時に遠くから寄っていく

  /**
   * URL の # で初期状態を指定できる（例: index.html#date=1999-12-31&focus=saturn&scale=300）
   *   date : 年-月-日（年は天文学的年号。紀元前1年 = 0, 紀元前3000年 = -2999）
   *   focus: sun / mercury / venus / earth / mars / jupiter / saturn / uranus / neptune
   *   scale: 惑星の拡大倍率（1〜2000）, el / az: 視点の仰角・方位角（度）, dist: 距離（au）
   */
  function applyHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.has('scale')) {
      const s = clamp(parseFloat(h.get('scale')) || 300, 1, SCALE_MAX);
      scaleInput.value = Math.round((Math.log10(s) / Math.log10(SCALE_MAX)) * 1000);
      setScale(s);
    }
    const m = (h.get('date') || '').match(/^(-?\d+)-(\d{1,2})-(\d{1,2})$/);
    if (m) {
      const y = +m[1], mo = clamp(+m[2], 1, 12);
      setJD(A.jdFromCalendar(y, mo, clamp(+m[3], 1, A.daysInMonth(y, mo))));
    }
    if (h.has('focus')) {
      const k = h.get('focus').toLowerCase();
      const i = k === 'sun' ? SUN_IDX : PL.findIndex((p) => p.key === k);
      if (i >= 0) { focus(i); cam.transT = 1; cam.dist = cam.distGoal * 3; }
    }
    if (h.has('el')) cam.el = clamp(+h.get('el'), 4, 89.5) * DEG;
    if (h.has('az')) cam.az = +h.get('az') * DEG;
    if (h.has('dist')) cam.distGoal = +h.get('dist');
  }
  applyHash();
  window.addEventListener('hashchange', applyHash);

  function frame(ts) {
    // 経過時間で進める（フレームレートに依存しない）。タブを裏にしていた後などの大きな飛びだけ 1秒で打ち切る
    const dt = lastTs === null ? 0 : Math.min(1, (ts - lastTs) / 1000);
    lastTs = ts;

    const prevJd = S.jd;
    if (S.live) S.jd = A.jdNow();
    else if (S.playing) {
      S.jd += S.rate * dt;
      if (S.jd >= JD_MAX) { S.jd = JD_MAX; S.playing = false; }
    }
    S.visDays += clamp(S.jd - prevJd, -dt, dt);

    updatePositions();
    updateCamera(dt);
    render(ts);
    hovered = listHover >= 0 ? listHover : mouse && !drag ? pick(mouse[0], mouse[1]) : -1;
    canvas.classList.toggle('pointing', hovered >= 0 && !drag);
    updateUI();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // 検証用（コンソールから日付を指定できる）
  window.orrery = { setJD, state: S, cam, bodies };
})();
