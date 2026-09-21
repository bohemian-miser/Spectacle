/**
 * WebGL2 instanced tile layer: one triangulated outline per leaf type, drawn
 * `drawElementsInstanced` with each tile's affine transform as instance
 * attributes, plus a per-tile tint (the owner's colour on claimed tiles).
 * A quarter of a million tiles is ~10 draw calls and no per-frame JS work,
 * which is what a level-6 arena needs. Strands are drawn by the Canvas2D
 * overlay on top; this layer is tiles only.
 */

import type { Field } from '../../shared/game/field';
import { leafPts, type Pt } from '../../shared/tiles';
import type { Camera } from './camera';
import type { Rgb01, TileLayer } from './tiles-layer';

const VS = `#version 300 es
precision highp float;
in vec2 a_local;
in vec3 a_m0;
in vec3 a_m1;
in vec4 a_tint;
uniform vec2 u_cam;
uniform float u_scale;
uniform vec2 u_half;
out vec4 v_tint;
void main() {
  vec2 w = vec2(dot(a_m0.xy, a_local) + a_m0.z, dot(a_m1.xy, a_local) + a_m1.z);
  vec2 s = (w - u_cam) * u_scale;
  gl_Position = vec4(s.x / u_half.x, -s.y / u_half.y, 0.0, 1.0);
  v_tint = a_tint;
}`;

const FS = `#version 300 es
precision mediump float;
in vec4 v_tint;
uniform vec4 u_fill;
uniform float u_useTint;
out vec4 o;
void main() {
  vec3 rgb = mix(u_fill.rgb, v_tint.rgb, v_tint.a * u_useTint);
  o = vec4(rgb, u_fill.a);
}`;

/** Ear-clipping triangulation of a simple polygon (n ≤ 14 here). */
function triangulate(pts: readonly Pt[]): number[] {
  const n = pts.length;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(i);
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    area += a.x * b.y - b.x * a.y;
  }
  if (area < 0) idx.reverse();
  const cross = (o: Pt, a: Pt, b: Pt): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const inside = (p: Pt, a: Pt, b: Pt, c: Pt): boolean =>
    cross(a, b, p) >= -1e-12 && cross(b, c, p) >= -1e-12 && cross(c, a, p) >= -1e-12;
  const out: number[] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 1000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i + idx.length - 1) % idx.length];
      const i1 = idx[i];
      const i2 = idx[(i + 1) % idx.length];
      const a = pts[i0];
      const b = pts[i1];
      const c = pts[i2];
      if (cross(a, b, c) <= 1e-12) continue; // reflex
      let ok = true;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (inside(pts[j], a, b, c)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      out.push(i0, i1, i2);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader');
  return sh;
}

interface TypeBatch {
  readonly vao: WebGLVertexArrayObject;
  readonly indexCount: number;
  readonly vertexCount: number;
  readonly first: number;
  readonly count: number;
  readonly fill: Rgb01;
}

/**
 * Software GL (SwiftShader, llvmpipe, Mesa's softpipe) rasterises a quarter
 * of a million instances in seconds per frame — worse than Canvas2D, whose
 * software path is well optimised. Prefer the 2D layer there unless forced.
 */
export function isSoftwareRenderer(gl: WebGL2RenderingContext): boolean {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  return /swiftshader|llvmpipe|softpipe|software|mesa offscreen/i.test(renderer);
}

export interface GlOptions {
  /** `true` forces WebGL even on a software renderer; `false` forbids it. */
  readonly force?: boolean;
}

/**
 * Probe on a throwaway canvas: a canvas that has ever handed out a WebGL
 * context can never hand out a 2D one, so the real canvas must stay untouched
 * until we know we are keeping WebGL.
 */
function webglUsable(force: boolean | undefined): boolean {
  if (force === false) return false;
  const probe = document.createElement('canvas');
  const gl = probe.getContext('webgl2');
  if (!gl) return false;
  const ok = force === true || !isSoftwareRenderer(gl);
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return ok;
}

export function createGlTiles(canvas: HTMLCanvasElement, field: Field, fills: readonly Rgb01[], opts: GlOptions = {}): TileLayer | null {
  if (!webglUsable(opts.force)) return null;
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, premultipliedAlpha: false });
  if (!gl) return null;

  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
  const loc = {
    local: gl.getAttribLocation(prog, 'a_local'),
    m0: gl.getAttribLocation(prog, 'a_m0'),
    m1: gl.getAttribLocation(prog, 'a_m1'),
    tint: gl.getAttribLocation(prog, 'a_tint'),
    cam: gl.getUniformLocation(prog, 'u_cam'),
    scale: gl.getUniformLocation(prog, 'u_scale'),
    half: gl.getUniformLocation(prog, 'u_half'),
    fill: gl.getUniformLocation(prog, 'u_fill'),
    useTint: gl.getUniformLocation(prog, 'u_useTint'),
  };

  // Instances sorted by type so each type is one contiguous instanced draw.
  const n = field.count;
  const types = field.leafTypes.length;
  const perType: number[] = new Array(types).fill(0);
  for (let i = 0; i < n; i++) perType[field.types[i]]++;
  const firstOf: number[] = [];
  let acc = 0;
  for (let t = 0; t < types; t++) {
    firstOf.push(acc);
    acc += perType[t];
  }
  const slotOf = new Int32Array(n);
  const cursor = [...firstOf];
  const inst = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const s = cursor[field.types[i]]++;
    slotOf[i] = s;
    for (let k = 0; k < 6; k++) inst[s * 6 + k] = field.xforms[i * 6 + k];
  }
  const tints = new Uint8Array(n * 4);

  const instBuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
  gl.bufferData(gl.ARRAY_BUFFER, inst, gl.STATIC_DRAW);
  const tintBuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, tintBuf);
  gl.bufferData(gl.ARRAY_BUFFER, tints, gl.DYNAMIC_DRAW);

  const batches: TypeBatch[] = [];
  for (let t = 0; t < types; t++) {
    if (perType[t] === 0) continue;
    const pts = leafPts(field.family, field.leafTypes[t]);
    const verts = new Float32Array(pts.length * 2);
    pts.forEach((p, i) => {
      verts[i * 2] = p.x;
      verts[i * 2 + 1] = p.y;
    });
    const tri = new Uint16Array(triangulate(pts));
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc.local);
    gl.vertexAttribPointer(loc.local, 2, gl.FLOAT, false, 0, 0);
    const ebo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, tri, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    const base = firstOf[t] * 24;
    gl.enableVertexAttribArray(loc.m0);
    gl.vertexAttribPointer(loc.m0, 3, gl.FLOAT, false, 24, base);
    gl.vertexAttribDivisor(loc.m0, 1);
    gl.enableVertexAttribArray(loc.m1);
    gl.vertexAttribPointer(loc.m1, 3, gl.FLOAT, false, 24, base + 12);
    gl.vertexAttribDivisor(loc.m1, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, tintBuf);
    gl.enableVertexAttribArray(loc.tint);
    gl.vertexAttribPointer(loc.tint, 4, gl.UNSIGNED_BYTE, true, 4, firstOf[t] * 4);
    gl.vertexAttribDivisor(loc.tint, 1);
    gl.bindVertexArray(null);
    batches.push({ vao, indexCount: tri.length, vertexCount: pts.length, first: firstOf[t], count: perType[t], fill: fills[t] });
  }

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  let tintsDirty = false;
  const tinted: number[] = [];

  return {
    kind: 'webgl',
    resize(pw, ph) {
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
    },
    clearTints() {
      for (const s of tinted) {
        tints[s * 4] = 0;
        tints[s * 4 + 1] = 0;
        tints[s * 4 + 2] = 0;
        tints[s * 4 + 3] = 0;
      }
      tinted.length = 0;
      tintsDirty = true;
    },
    setTint(tile, r, g, b, a) {
      const s = slotOf[tile];
      tints[s * 4] = r;
      tints[s * 4 + 1] = g;
      tints[s * 4 + 2] = b;
      tints[s * 4 + 3] = a;
      tinted.push(s);
      tintsDirty = true;
    },
    draw(cam: Camera, width: number, height: number, dpr: number) {
      if (tintsDirty) {
        gl.bindBuffer(gl.ARRAY_BUFFER, tintBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, tints);
        tintsDirty = false;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0.043, 0.051, 0.071, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.uniform2f(loc.cam, cam.x, cam.y);
      gl.uniform1f(loc.scale, cam.scale * dpr);
      gl.uniform2f(loc.half, (width * dpr) / 2, (height * dpr) / 2);
      const outlines = cam.scale > 4;
      for (const b of batches) {
        gl.bindVertexArray(b.vao);
        gl.uniform4f(loc.fill, b.fill[0], b.fill[1], b.fill[2], 1);
        gl.uniform1f(loc.useTint, 1);
        gl.drawElementsInstanced(gl.TRIANGLES, b.indexCount, gl.UNSIGNED_SHORT, 0, b.count);
        if (outlines) {
          gl.uniform4f(loc.fill, 1, 1, 1, 0.1);
          gl.uniform1f(loc.useTint, 0);
          gl.drawArraysInstanced(gl.LINE_LOOP, 0, b.vertexCount, b.count);
        }
      }
      gl.bindVertexArray(null);
    },
    dispose() {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
