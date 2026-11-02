
"""GPU-backed live-capture liquid glass, an optional companion to glass_window.py.

The UI, masks, layout, text and snapshot behaviour all come from PR #15.
Only the per-frame capture -> blur -> warp -> lens composite is moved to the GPU.
"""
import ctypes
import os
import sys
import time

import moderngl
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import glass_window as G

VERT = r"""
#version 330
in vec2 in_pos;
out vec2 v_uv;
void main() {
    v_uv = in_pos * 0.5 + 0.5;
    gl_Position = vec4(in_pos, 0.0, 1.0);
}
"""

FRAG_DOWN = r"""
#version 330
uniform sampler2D tex;
in vec2 v_uv;
out vec4 frag;
void main() {
    vec4 c = texture(tex, v_uv);
    frag = vec4(c.bgr, 1.0);
}
"""

FRAG_BLUR = r"""
#version 330
uniform sampler2D tex;
uniform vec2 texel;
uniform float sigma;
uniform vec2 dir;
in vec2 v_uv;
out vec4 frag;
void main() {
    // Pair adjacent taps through a linear-filtered sample: halves the
    // texture fetches while keeping the same Gaussian weights.
    int radius = int(min(32.0, ceil(sigma * 3.0)));
    float total = 0.0;
    vec3 sum = vec3(0.0);
    for (int i = -32; i <= 32; i += 2) {
        if (i < -radius) continue;
        float fi = float(i);
        float w0 = exp(-0.5 * (fi * fi) / (sigma * sigma));
        int j = i + 1;
        if (j > radius) {
            sum += texture(tex, v_uv + dir * texel * fi).rgb * w0;
            total += w0;
        } else {
            float fj = float(j);
            float w1 = exp(-0.5 * (fj * fj) / (sigma * sigma));
            float x = (fi * w0 + fj * w1) / (w0 + w1);
            sum += texture(tex, v_uv + dir * texel * x).rgb * (w0 + w1);
            total += w0 + w1;
        }
    }
    frag = vec4(sum / total, 1.0);
}
"""

FRAG_WARP = r"""
#version 330
uniform sampler2D src;
uniform sampler2D coord;
uniform vec2 offset;
uniform vec2 src_size;
in vec2 v_uv;
out vec4 frag;
void main() {
    vec2 c = texelFetch(coord, ivec2(gl_FragCoord.xy), 0).rg + offset;
    ivec2 p = ivec2(floor(c + 0.5));
    p = clamp(p, ivec2(0), ivec2(src_size) - 1);
    frag = texelFetch(src, p, 0);
}
"""

FRAG_BOX = r"""
#version 330
uniform sampler2D warped;
uniform sampler2D strongw;
uniform sampler2D raw;
uniform sampler2D alpha;
uniform sampler2D edge;
uniform sampler2D coord;
uniform vec2 offset;
uniform vec2 src_size;
in vec2 v_uv;
out vec4 frag;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec3 base = texelFetch(warped, p, 0).rgb;
    vec3 strong = texelFetch(strongw, p, 0).rgb;
    float a = texelFetch(alpha, p, 0).r;
    float e = texelFetch(edge, p, 0).r;
    vec2 ec = texelFetch(coord, p, 0).rg + offset;
    ivec2 ep = clamp(ivec2(floor(ec + 0.5)), ivec2(0), ivec2(src_size) - 1);
    vec3 edgep = texelFetch(raw, ep, 0).rgb;
    vec3 patch = mix(strong, edgep, e);
    frag = vec4(mix(base, patch, a), 1.0);
}
"""

FRAG_PANEL = r"""
#version 330
uniform sampler2D warped;
uniform sampler2D lens;
uniform sampler2D union_mask;
uniform sampler2D overlay;
in vec2 v_uv;
out vec4 frag;
void main() {
    vec3 base = texture(warped, v_uv).rgb;
    vec3 lensc = texture(lens, v_uv).rgb;
    float m = texture(union_mask, v_uv).r;
    vec3 c = mix(base, lensc, m);
    vec4 o = texture(overlay, v_uv);
    c = c * (1.0 - o.a) + o.rgb * o.a;
    frag = vec4(c, 1.0);
}
"""

FRAG_POST = r"""
#version 330
uniform sampler2D curr;
uniform sampler2D prev;
uniform vec2 texel;
uniform float blend;
uniform float chroma;
in vec2 v_uv;
out vec4 frag;
void main() {
    vec3 c = texture(curr, v_uv).rgb;
    vec3 p = texture(prev, v_uv).rgb;
    // 运动残影：只混一点点上一帧，遮住延迟造成的逐帧跳变/撕裂感
    c = mix(c, p, blend);
    // 外框色散：只在靠近窗口圆角外缘的窄带里把 R/B 沿径向错开
    vec2 d = v_uv - 0.5;
    float r = length(d);
    float edge = smoothstep(0.38, 0.48, r) * (1.0 - smoothstep(0.52, 0.585, r));
    if (edge > 0.001) {
        vec2 dir = normalize(d + vec2(1e-5));
        float k = chroma * edge;
        vec3 cc;
        cc.r = texture(curr, v_uv + dir * texel * k).r;
        cc.g = c.g;
        cc.b = texture(curr, v_uv - dir * texel * k).b;
        c = mix(c, cc, edge);
    }
    frag = vec4(c, 1.0);
}
"""

FRAG_FINAL = r"""
#version 330
uniform sampler2D tex;
in vec2 v_uv;
out vec4 frag;
void main() { frag = texture(tex, v_uv); }
"""

def _resize_f32(arr, size):
    chans = []
    for i in range(arr.shape[2]):
        im = Image.fromarray(np.ascontiguousarray(arr[:, :, i]), mode="F")
        chans.append(np.asarray(im.resize(size, Image.Resampling.BILINEAR), dtype=np.float32))
    return np.stack(chans, axis=-1)

def _resize_mask(arr, size):
    im = Image.fromarray((np.clip(arr, 0.0, 1.0) * 255.0).astype(np.uint8), mode="L")
    im = im.resize(size, Image.Resampling.BILINEAR)
    return np.asarray(im, dtype=np.float32) / 255.0

def _boost_worker():
    """GPU 工作线程略高于普通优先级，减少被系统调度挤开的抖动。
    只提到 ABOVE_NORMAL + HIGHEST，不用 REALTIME，避免抢 UI/音频。"""
    try:
        k = ctypes.windll.kernel32
        k.SetPriorityClass(k.GetCurrentProcess(), 0x00008000)  # ABOVE_NORMAL
        k.SetThreadPriority(k.GetCurrentThread(), 2)           # THREAD_PRIORITY_HIGHEST
        ctypes.windll.winmm.timeBeginPeriod(1)
    except Exception:
        pass

class GPULens:
    def __init__(self):
        _boost_worker()
        self.ctx = moderngl.create_standalone_context(require=330)
        tri = np.array([-1.0, -1.0, 3.0, -1.0, -1.0, 3.0], dtype="f4")
        self.vbo = self.ctx.buffer(tri.tobytes())
        self.progs = {}
        for name, fs in (("down", FRAG_DOWN), ("blur", FRAG_BLUR),
                         ("warp", FRAG_WARP), ("box", FRAG_BOX),
                         ("panel", FRAG_PANEL), ("final", FRAG_FINAL), ("post", FRAG_POST)):
            p = self.ctx.program(vertex_shader=VERT, fragment_shader=fs)
            self.progs[name] = p
            p.vao = self.ctx.vertex_array(p, [(self.vbo, "2f", "in_pos")])
        self.native = os.environ.get("DSH_GLASS_NATIVE") == "1"
        self._prev_valid = False
        self._motion = 0.0
        self.src = None
        self.geo = None
        self.fbos = {}
        self.texs = {}

    def _fbo(self, key, size):
        old = self.fbos.get(key)
        if old is not None and old.size == size:
            return old
        if old is not None:
            old.release()
        tex = self.ctx.texture(size, 4)
        tex.filter = (moderngl.LINEAR, moderngl.LINEAR)
        tex.repeat_x = False
        tex.repeat_y = False
        fbo = self.ctx.framebuffer(color_attachments=[tex])
        self.fbos[key] = fbo
        self.texs[key] = tex
        return fbo

    def _tex(self, key, size, components=1, dtype="f4", data=None):
        old = self.texs.get(key)
        if old is not None and old.size == size and old.components == components:
            if data is not None:
                old.write(data)
            return old
        if old is not None:
            old.release()
        t = self.ctx.texture(size, components, dtype=dtype, data=data)
        t.filter = (moderngl.NEAREST, moderngl.NEAREST)
        t.repeat_x = False
        t.repeat_y = False
        self.texs[key] = t
        return t

    def _set(self, prog, **kw):
        for k, v in kw.items():
            try:
                prog[k] = v
            except KeyError:
                pass

    def _build_geo(self):
        W, H = G.W, G.H
        qw, qh = max(4, W // 4), max(4, H // 4)
        alpha_q = np.zeros((qh, qw), dtype="f4")
        edge_q = np.zeros((qh, qw), dtype="f4")
        coord_q = np.zeros((qh, qw, 2), dtype="f4")
        for qx0, qy0, bqw, bqh, a, e, bsx, bsy in G.BOX_MAPS:
            alpha_q[qy0:qy0 + bqh, qx0:qx0 + bqw] = a
            edge_q[qy0:qy0 + bqh, qx0:qx0 + bqw] = e.astype(np.float32)
            coord_q[qy0:qy0 + bqh, qx0:qx0 + bqw, 0] = bsx
            coord_q[qy0:qy0 + bqh, qx0:qx0 + bqw, 1] = bsy
        warp_q = np.stack([G.WARP_X, G.WARP_Y], axis=-1).astype("f4")
        if self.native:
            hw, hh = W, H
            HW, HH = W, H
            alpha = _resize_mask(alpha_q, (hw, hh))
            edge = _resize_mask(edge_q, (hw, hh))
            # Everything in the inner boxes is sampled from the native
            # capture (no quarter-res raw), so the lens edges have no
            # upscaled pixel feel.
            coord = _resize_f32(coord_q * 4.0, (hw, hh))
            warp = _resize_f32(warp_q * 4.0, (hw, hh))
            overlay = np.asarray(G.OVERLAY.convert("RGBA"), dtype=np.uint8)
            union = np.asarray(G.BOX_UNION_2X.resize((W, H), Image.Resampling.BILINEAR), dtype=np.uint8)
        else:
            hw, hh = qw, qh
            HW, HH = W // 2, H // 2
            alpha, edge, coord, warp = alpha_q, edge_q, coord_q, warp_q
            overlay = np.asarray(G.OVERLAY_2X.convert("RGBA"), dtype=np.uint8)
            union = np.asarray(G.BOX_UNION_2X, dtype=np.uint8)
        self._tex("alpha", (hw, hh), 1, "f4", np.ascontiguousarray(alpha).tobytes())
        self._tex("edge", (hw, hh), 1, "f4", np.ascontiguousarray(edge).tobytes())
        self._tex("coord", (hw, hh), 2, "f4", np.ascontiguousarray(coord).tobytes())
        self._tex("warpcoord", (hw, hh), 2, "f4", np.ascontiguousarray(warp).tobytes())
        t = self._tex("overlay", (HW, HH), 4, "f1", overlay.tobytes())
        t.filter = (moderngl.LINEAR, moderngl.LINEAR)
        t = self._tex("union", (HW, HH), 1, "f1", union.tobytes())
        t.filter = (moderngl.LINEAR, moderngl.LINEAR)
        self.geo = (W, H, hw, hh, HW, HH)
        self.fbos.clear()
        self.texs = {k: v for k, v in self.texs.items()
                     if k in ("alpha", "edge", "coord", "warpcoord", "overlay", "union")}

    def _ensure_src(self, size, data):
        if self.src is None or self.src.size != size:
            if self.src is not None:
                self.src.release()
            self.src = self.ctx.texture(size, 4)
            self.src.filter = (moderngl.LINEAR, moderngl.LINEAR)
            self.src.repeat_x = False
            self.src.repeat_y = False
        self.src.write(data)

    def render(self, bgra, size, px, py, motion=0.0):
        if self.geo is None or self.geo[:2] != (G.W, G.H):
            self._build_geo()
        W, H, hw, hh, HW, HH = self.geo
        gw, gh = size
        self._ensure_src((gw, gh), bgra)

        if self.native:
            cw, ch = gw, gh
            raw = self._fbo("raw", (cw, ch))
            raw.use(); self.ctx.viewport = (0, 0, cw, ch)
            self.src.use(0)
            p = self.progs["down"]; p["tex"] = 0; p.vao.render(moderngl.TRIANGLES)
            # 内框也走原生 raw；边缘不带 1/4 放大的像素感。
            # 内框的“厚模糊”由下面更强的 strong sigma 提供。
            base_raw = raw
            bw, bh = cw, ch
            ox, oy = float(px), float(py)
            box_ox, box_oy = float(px), float(py)
            box_bw, box_bh = cw, ch
        else:
            bw, bh = max(2, gw // 4), max(2, gh // 4)
            raw = self._fbo("raw", (bw, bh))
            raw.use(); self.ctx.viewport = (0, 0, bw, bh)
            self.src.use(0)
            p = self.progs["down"]; p["tex"] = 0; p.vao.render(moderngl.TRIANGLES)
            base_raw = raw
            ox, oy = float(px), float(py)
            box_raw = raw
            box_ox, box_oy = float(px), float(py)
            box_bw, box_bh = bw, bh

        small = self._fbo("small", (bw, bh))
        strong = self._fbo("strong", (bw, bh))
        tmp = self._fbo("tmp", (bw, bh))
        warped = self._fbo("warped", (hw, hh))
        strongw = self._fbo("strongw", (hw, hh))
        lens = self._fbo("lens", (hw, hh))
        panel2x = self._fbo("panel2x", (HW, HH))
        out = self._fbo("out", (W, H))

        def blur(dst, srctex, sigma):
            tmp.use(); self.ctx.viewport = (0, 0, bw, bh)
            srctex.use(0)
            p = self.progs["blur"]; p["tex"] = 0; p["texel"] = (1.0 / bw, 1.0 / bh)
            p["sigma"] = sigma; p["dir"] = (1.0, 0.0); p.vao.render(moderngl.TRIANGLES)
            dst.use(); self.ctx.viewport = (0, 0, bw, bh)
            tmp.color_attachments[0].use(0)
            p["dir"] = (0.0, 1.0); p.vao.render(moderngl.TRIANGLES)

        sigma_scale = 4.0 if self.native else 1.0
        blur(small, base_raw.color_attachments[0], 1.45 * sigma_scale)
        # 内框中心再多加一点模糊；只影响 strongw / 内框，不影响底图。
        strong_boost = 1.45 if self.native else 1.0
        blur(strong, small.color_attachments[0], 2.6 * sigma_scale * strong_boost)

        for dst, src in ((warped, small), (strongw, strong)):
            dst.use(); self.ctx.viewport = (0, 0, hw, hh)
            src.color_attachments[0].use(0)
            self.texs["warpcoord"].use(1)
            p = self.progs["warp"]; self._set(p, src=0, coord=1, offset=(float(ox), float(oy)),
                                              src_size=(float(bw), float(bh)))
            p.vao.render(moderngl.TRIANGLES)

        lens.use(); self.ctx.viewport = (0, 0, hw, hh)
        warped.color_attachments[0].use(0)
        strongw.color_attachments[0].use(1)
        (small if self.native else box_raw).color_attachments[0].use(2)
        self.texs["alpha"].use(3)
        self.texs["edge"].use(4)
        self.texs["coord"].use(5)
        p = self.progs["box"]
        self._set(p, warped=0, strongw=1, raw=2, alpha=3, edge=4, coord=5,
                  offset=(float(box_ox), float(box_oy)),
                  src_size=(float(box_bw), float(box_bh)))
        p.vao.render(moderngl.TRIANGLES)

        panel2x.use(); self.ctx.viewport = (0, 0, HW, HH)
        warped.color_attachments[0].use(0)
        lens.color_attachments[0].use(1)
        self.texs["union"].use(2)
        self.texs["overlay"].use(3)
        p = self.progs["panel"]
        self._set(p, warped=0, lens=1, union_mask=2, overlay=3)
        p.vao.render(moderngl.TRIANGLES)

        if self.native:
            base_out = panel2x
        else:
            final = self._fbo("final", (W, H))
            final.use(); self.ctx.viewport = (0, 0, W, H)
            panel2x.color_attachments[0].use(0)
            p = self.progs["final"]; p["tex"] = 0; p.vao.render(moderngl.TRIANGLES)
            base_out = final

        prev = self._fbo("prev", (W, H))
        out.use(); self.ctx.viewport = (0, 0, W, H)
        base_out.color_attachments[0].use(0)
        prev.color_attachments[0].use(1)
        p = self.progs["post"]
        p["texel"] = (1.0 / W, 1.0 / H)
        p["blend"] = float(0.55 * max(0.0, min(1.0, motion)) if getattr(self, "_prev_valid", False) else 0.0)
        p["chroma"] = 3.6 * (W / 900.0)
        self._set(p, curr=0, prev=1)
        p.vao.render(moderngl.TRIANGLES)
        self.ctx.copy_framebuffer(prev, out)
        self._prev_valid = True

        data = out.read(components=3, alignment=1)
        return Image.frombytes("RGB", (W, H), data)

_gpu = None
_orig_capture = G.LiveGlass._capture

def capture_gpu(self, sct):
    global _gpu
    try:
        if _gpu is None:
            _gpu = GPULens()
        l, t, r, b = self._bbox()
        if r <= l or b <= t:
            return None
        gl = max(0, l - G.PAD)
        gt = max(0, t - G.PAD)
        gr = min(self._sw, r + G.PAD)
        gb = min(self._sh, b + G.PAD)
        shot = sct.grab({"left": gl, "top": gt, "width": gr - gl, "height": gb - gt})
        factor = 1.0 if _gpu.native else 4.0
        px = int(round((l - gl) / factor))
        py = int(round((t - gt) / factor))

        # 静态判断放在渲染之前：用抓到的原始 BGRA 直接算签名，静止时
        # 连 GPU 合成都不做；运动时把强度交给 post pass 做残影。
        sw, sh = shot.size
        raw = np.frombuffer(shot.bgra, dtype=np.uint8).reshape(sh, sw, 4)
        sig = raw[::4, ::4, :3].astype(np.int16).mean(axis=2)
        box = (gl, gt, gr, gb)
        now = time.perf_counter()
        moved = False
        if self._sig is not None and box == self._sig_bbox and sig.shape == self._sig.shape:
            d = np.abs(sig - self._sig)
            moved = bool(float(d.mean()) > 0.01 or float(d.max()) > 0.5)
        if moved:
            self._last_motion = now
            _gpu._motion = min(1.0, _gpu._motion * 0.60 + 0.40)
        else:
            _gpu._motion *= 0.80
        if (not G.FORCE and not moved and box == self._sig_bbox
                and now - getattr(self, "_last_motion", 0.0) > 0.30):
            self._sig = sig
            _gpu._motion = 0.0
            return None
        self._sig = sig
        self._sig_bbox = box

        panel = _gpu.render(shot.bgra, shot.size, px, py, motion=_gpu._motion)
        # 麦克风由 window.py 的 Canvas 图标绘制，GPU 路径不再叠第二层。
        return G.finish(panel.convert("RGB"))
    except Exception as exc:
        print("GPU capture failed, falling back to CPU:", repr(exc), flush=True)
        return _orig_capture(self, sct)

G.LiveGlass._capture = capture_gpu

# PR15's SNAPSHOT path is re-armed by _tick; make the doc screenshot path keep
# capture paused and WDA disabled, without touching the normal path.
def _snap(self, _e=None):
    self._snapshot_done = True
    self._pause.set()
    if self._excluded:
        self._set_exclude(False)

def _tick(self):
    if getattr(self, "_snapshot_done", False):
        if self._excluded:
            self._set_exclude(False)
        self.root.after(100, self._tick)
        return
    return _orig_tick(self)

if os.environ.get("DSH_GLASS_SNAPSHOT") == "1":
    _orig_tick = G.LiveGlass._tick
    G.LiveGlass._snapshot_mode = _snap
    G.LiveGlass._tick = _tick

if __name__ == "__main__":
    app = G.LiveGlass()
    app.run()