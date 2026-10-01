#!/usr/bin/env python3
"""对照 BlitzKit 缓存与本机自行导出的坦克模型（`model.glb` / `collision.glb`）。

两条对照通道：

  1. **数值等价**（`--audit`）——按**可达节点**求和后逐节点比对。口径要点：BlitzKit 的
     GLB 经 glTF-Transform 对相同 mesh 做了去重、逐节点复用，若按"文件内 mesh 求和"
     统计会误报不一致；必须以"从场景根可达的每个节点所挂 mesh"为准（本项目的历史教训）。
     逐节点比对：节点路径 → (顶点数, 索引数)，以及 POSITION/NORMAL/TEXCOORD_0 的
     原始字节与索引数值。

  2. **并排渲染**（`--render`）——同一相机、同一光照下把两份 GLB 各渲一遍（自写
     z-buffer 光栅器，无第三方渲染依赖），输出 [BlitzKit | 本地 | 差异] 三联图；
     差异图给出轮廓 XOR（红=仅本地有、蓝=仅 BlitzKit 有）与像素级平均绝对差。
     贴图存在时按 UV 采样 baseColor，因此"效果"里包含颜色而不只是形状。

用法：
    python tools/compare_tank_glb.py --tank 9489 --tank 7169 --render
    python tools/compare_tank_glb.py --all --audit            # 全量数值回归
    python tools/compare_tank_glb.py --tank 9489 --render --out-dir data/cache/local_compare

BlitzKit 缓存目录缺某辆时记为 `no-blitzkit`（本机未预下载），不视为差异。
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import pathlib
import struct
import sys

import numpy as np

TOOLS_DIR = pathlib.Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent

COMP = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}


# ---------------------------------------------------------------------------
# GLB 读取（独立实现，按规范解析 accessor → bufferView → buffer，支持 byteStride）
# ---------------------------------------------------------------------------
def read_glb(path: pathlib.Path):
    raw = path.read_bytes()
    magic, _ver, length = struct.unpack_from("<III", raw, 0)
    if magic != 0x46546C67:
        raise ValueError(f"bad GLB magic {magic:#x}: {path}")
    if length != len(raw):
        raise ValueError(f"declared length {length} != file length {len(raw)}: {path}")
    off, js, binc = 12, None, None
    while off < len(raw):
        clen, ctype = struct.unpack_from("<I4s", raw, off)
        body = raw[off + 8:off + 8 + clen]
        if ctype == b"JSON":
            js = json.loads(body.decode("utf-8"))
        elif ctype == b"BIN\x00":
            binc = body
        off += 8 + clen
    return js, binc


def accessor_bytes(js, binc, i: int) -> bytes:
    """accessor i 的紧凑字节（去掉 byteStride 间隙）。"""
    a = js["accessors"][i]
    bv = js["bufferViews"][a["bufferView"]]
    _fmt, size = COMP[a["componentType"]]
    elem = size * NCOMP[a["type"]]
    start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = bv.get("byteStride") or elem
    count = a["count"]
    if stride == elem:
        return binc[start:start + elem * count]
    return b"".join(binc[start + k * stride:start + k * stride + elem] for k in range(count))


def accessor_array(js, binc, i: int) -> np.ndarray:
    a = js["accessors"][i]
    fmt, size = COMP[a["componentType"]]
    n = NCOMP[a["type"]]
    raw = accessor_bytes(js, binc, i)
    arr = np.frombuffer(raw, dtype=np.dtype(f"<{fmt}"))
    return arr.reshape(a["count"], n) if n > 1 else arr.reshape(a["count"])


def scene_roots(js) -> list[int]:
    scenes = js.get("scenes") or []
    if scenes:
        return list(scenes[js.get("scene", 0)].get("nodes", []))
    child = {c for n in js.get("nodes", []) for c in n.get("children", [])}
    return [i for i in range(len(js.get("nodes", []))) if i not in child]


def walk_nodes(js) -> list[tuple[str, str, int, int]]:
    """(path, name, vertices, indices)——按可达节点，共享 mesh 逐节点重复计。"""
    nodes, acc, meshes = js.get("nodes", []), js.get("accessors", []), js.get("meshes", [])
    out: list[tuple[str, str, int, int]] = []

    def walk(i: int, prefix: str) -> None:
        n = nodes[i]
        nm = n.get("name", "")
        path = f"{prefix}/{nm}"
        v = ix = 0
        if "mesh" in n:
            for pr in meshes[n["mesh"]]["primitives"]:
                v += acc[pr["attributes"]["POSITION"]]["count"]
                if "indices" in pr:
                    ix += acc[pr["indices"]]["count"]
        out.append((path, nm, v, ix))
        for c in n.get("children", []):
            walk(c, path)

    for r in scene_roots(js):
        walk(r, "")
    return out


def signature(js, binc) -> dict[str, tuple]:
    """节点路径 → (顶点数, 索引数, POSITION, NORMAL, TEXCOORD_0, TEXCOORD_1, TEXCOORD_2, 索引) 原始字节。

    原始字节留空表示该节点无此属性（例如 collision.glb 无 UV、无材质）。
    """
    nodes, meshes = js.get("nodes", []), js.get("meshes", [])
    sig: dict[str, tuple] = {}

    def walk(i: int, prefix: str) -> None:
        n = nodes[i]
        path = f"{prefix}/{n.get('name', '')}"
        v = ix = 0
        pos = nrm = uv0 = uv1 = uv2 = idx = b""
        if "mesh" in n:
            pr = meshes[n["mesh"]]["primitives"][0]
            at = pr["attributes"]
            v = js["accessors"][at["POSITION"]]["count"]
            pos = accessor_bytes(js, binc, at["POSITION"])
            if "NORMAL" in at:
                nrm = accessor_bytes(js, binc, at["NORMAL"])
            for key, var in (("TEXCOORD_0", "uv0"), ("TEXCOORD_1", "uv1"), ("TEXCOORD_2", "uv2")):
                if key in at:
                    if var == "uv0":
                        uv0 = accessor_bytes(js, binc, at[key])
                    elif var == "uv1":
                        uv1 = accessor_bytes(js, binc, at[key])
                    else:
                        uv2 = accessor_bytes(js, binc, at[key])
            if "indices" in pr:
                ix = js["accessors"][pr["indices"]]["count"]
                idx = accessor_bytes(js, binc, pr["indices"])
        sig[path] = (v, ix, pos, nrm, uv0, uv1, uv2, idx)
        for c in n.get("children", []):
            walk(c, path)

    for r in scene_roots(js):
        walk(r, "")
    return sig


def compare_artifact(bk_path: pathlib.Path, local_path: pathlib.Path) -> dict:
    """比对单个 GLB：节点集合/顺序、每节点顶点与索引数、原始属性字节（含 UV1/UV2）。"""
    bjs, bb = read_glb(bk_path)
    ljs, lb = read_glb(local_path)
    bsig, lsig = signature(bjs, bb), signature(ljs, lb)
    bpaths, lpaths = list(bsig), list(lsig)

    only_bk = [p for p in bpaths if p not in lsig]
    only_lc = [p for p in lpaths if p not in bsig]
    common = [p for p in bpaths if p in lsig]
    diff_count = [p for p in common if bsig[p][:2] != lsig[p][:2]]
    diff_pos = [p for p in common if bsig[p][2] != lsig[p][2]]
    diff_nrm = [p for p in common if bsig[p][3] != lsig[p][3]]
    diff_uv = [p for p in common if bsig[p][4] != lsig[p][4]]
    diff_uv1 = [p for p in common if bsig[p][5] != lsig[p][5]]
    diff_uv2 = [p for p in common if bsig[p][6] != lsig[p][6]]
    diff_idx = [p for p in common if bsig[p][7] != lsig[p][7]]
    bv = sum(v for _, _, v, _ in walk_nodes(bjs))
    lv = sum(v for _, _, v, _ in walk_nodes(ljs))
    bi = sum(i for _, _, _, i in walk_nodes(bjs))
    li = sum(i for _, _, _, i in walk_nodes(ljs))
    equal = (not only_bk and not only_lc and not diff_count and not diff_pos
             and not diff_nrm and not diff_uv and not diff_uv1 and not diff_uv2
             and not diff_idx and bv == lv and bi == li)
    return {
        "equal": equal,
        "node_order_equal": bpaths == lpaths,
        "nodes": {"blitzkit": len(bpaths), "local": len(lpaths)},
        "verts": {"blitzkit": bv, "local": lv},
        "indices": {"blitzkit": bi, "local": li},
        "only_blitzkit": only_bk, "only_local": only_lc,
        "diff_counts": diff_count, "diff_position": diff_pos,
        "diff_normal": diff_nrm, "diff_uv": diff_uv, "diff_uv1": diff_uv1,
        "diff_uv2": diff_uv2, "diff_index_values": diff_idx,
    }


def audit_one(args: tuple) -> dict:
    tank_id, bk_root, local_root = args
    out = {"tank_id": tank_id}
    for art in ("model.glb", "collision.glb"):
        bk, lc = bk_root / str(tank_id) / art, local_root / str(tank_id) / art
        if not bk.exists():
            out[art] = {"status": "no-blitzkit"}
            continue
        if not lc.exists():
            out[art] = {"status": "no-local"}
            continue
        try:
            r = compare_artifact(bk, lc)
            out[art] = {"status": "equal" if r["equal"] else "diff", **r}
        except Exception as e:  # noqa: BLE001
            out[art] = {"status": "error", "error": f"{type(e).__name__}: {e}"}
    return out


# ---------------------------------------------------------------------------
# 软件光栅器（z-buffer + Lambert 平面着色 + 可选 baseColor 采样）
# ---------------------------------------------------------------------------
def _mat4(node: dict) -> np.ndarray:
    if "matrix" in node:
        return np.array(node["matrix"], dtype=np.float64).reshape(4, 4).T  # glTF 列主序
    m = np.eye(4)
    t, r, s = node.get("translation"), node.get("rotation"), node.get("scale")
    if s:
        m = np.diag([*s, 1.0]) @ m
    if r:
        x, y, z, w = r
        rot = np.array([
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0],
            [0, 0, 0, 1]], dtype=np.float64)
        m = rot @ m
    if t:
        tr = np.eye(4)
        tr[:3, 3] = t
        m = tr @ m
    return m


def gather_triangles(js, binc) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """→ (tris (T,3,3) 世界坐标, uvs (T,3,2) 或 None, base_color 每三角形材质贴图 id 或 -1)。"""
    nodes, meshes, mats = js.get("nodes", []), js.get("meshes", []), js.get("materials", [])
    tris, uvs, texs = [], [], []

    def walk(i: int, parent: np.ndarray) -> None:
        n = nodes[i]
        world = parent @ _mat4(n)
        if "mesh" in n:
            for pr in meshes[n["mesh"]]["primitives"]:
                at = pr["attributes"]
                pos = accessor_array(js, binc, at["POSITION"]).astype(np.float64)
                if pos.shape[1] == 2:
                    pos = np.hstack([pos, np.zeros((len(pos), 1))])
                idx = accessor_array(js, binc, pr["indices"]).astype(np.int64) if "indices" in pr \
                    else np.arange(len(pos))
                p = (world[:3, :3] @ pos.T).T + world[:3, 3]
                tri = p[idx.reshape(-1, 3)]
                uv = None
                if "TEXCOORD_0" in at:
                    t = accessor_array(js, binc, at["TEXCOORD_0"]).astype(np.float64)
                    uv = t[idx.reshape(-1, 3)]
                tex = -1
                mi = pr.get("material")
                if mi is not None and mi < len(mats):
                    bt = (mats[mi].get("pbrMetallicRoughness") or {}).get("baseColorTexture")
                    if bt:
                        tex = bt["index"]
                tris.append(tri)
                uvs.append(uv if uv is not None else np.zeros((len(tri), 3, 2)))
                texs.append(np.full(len(tri), tex, dtype=np.int64))
        for c in n.get("children", []):
            walk(c, world)

    for r in scene_roots(js):
        walk(r, np.eye(4))
    if not tris:
        return np.zeros((0, 3, 3)), np.zeros((0, 3, 2)), np.zeros(0, dtype=np.int64)
    return np.concatenate(tris), np.concatenate(uvs), np.concatenate(texs)


def load_texture(js, binc, tex_index: int):
    """纹理 id → PIL 图像（**RGBA**，保留 alpha 以便复现 MASK 镂空）；失败返回 None。"""
    try:
        from PIL import Image
        import io
        img = js["images"][js["textures"][tex_index]["source"]]
        bv = js["bufferViews"][img["bufferView"]]
        data = binc[bv.get("byteOffset", 0):bv.get("byteOffset", 0) + bv["byteLength"]]
        return Image.open(io.BytesIO(data)).convert("RGBA")
    except Exception:  # noqa: BLE001
        return None


def _view_matrix(yaw: float, pitch: float) -> np.ndarray:
    ry, rp = np.radians(yaw), np.radians(pitch)
    ry_m = np.array([[np.cos(ry), 0, np.sin(ry)], [0, 1, 0], [-np.sin(ry), 0, np.cos(ry)]])
    rp_m = np.array([[1, 0, 0], [0, np.cos(rp), -np.sin(rp)], [0, np.sin(rp), np.cos(rp)]])
    return rp_m @ ry_m


def _uv_px(img, uv: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    th, tw = img.size[1], img.size[0]
    px = np.clip((uv[:, 0] % 1.0) * (tw - 1), 0, tw - 1).astype(np.int32)
    py = np.clip((uv[:, 1] % 1.0) * (th - 1), 0, th - 1).astype(np.int32)
    return py, px


def _tex_lookup(img, uv: np.ndarray) -> np.ndarray:
    """按 UV 采样 baseColor（取小数部分平铺），返回 (N,3)。"""
    py, px = _uv_px(img, uv)
    return np.asarray(img.convert("RGB"), dtype=np.float32)[py, px]


def _alpha_lookup(img, uv: np.ndarray) -> np.ndarray:
    """按 UV 采样 alpha，返回 (N,) uint8。"""
    py, px = _uv_px(img, uv)
    return np.asarray(img.getchannel("A"))[py, px]


def render_points(pos: np.ndarray, uvs: np.ndarray, texs: np.ndarray, textures: dict,
                  size: int = 480, yaw: float = -35.0, pitch: float = 20.0,
                  aabb: tuple | None = None, splat: int = 1,
                  cutoffs: np.ndarray | None = None) -> np.ndarray:
    """向量化顶点泼溅渲染（默认）：投影全部顶点 → z-buffer 取最近者写入。

    比逐三角光栅快两个量级（无 Python 三角循环），配合 `splat` 半径可得到致密实心图；
    代价是几何边缘为顶点级精度，不适合看 1 像素级的轮廓差。要看轮廓细节用 `--render-mode tri`。

    `cutoffs` 给每个顶点的 MASK 阈值（-1 = 不遮罩）：有掩膜的顶点按 UV 采样 alpha，
    `alpha < cutoff` 的顶点**不写入**——这样履带等的 alpha 镂空才能被如实渲染出来，
    渲染差异图也才对该差异敏感。
    """
    if len(pos) == 0:
        return np.full((size, size, 3), 255, np.uint8)
    if cutoffs is not None and (cutoffs >= 0).any():
        vis = np.ones(len(pos), dtype=bool)
        masked = cutoffs >= 0
        for t in {int(x) for x in texs[masked] if x >= 0}:
            if t not in textures:
                continue
            sel = masked & (texs == t)
            a = _alpha_lookup(textures[t], uvs[sel]).astype(np.float32)
            vis[sel] = a >= cutoffs[sel] * 255.0
        pos, uvs, texs = pos[vis], uvs[vis], texs[vis]
        if len(pos) == 0:
            return np.full((size, size, 3), 255, np.uint8)
    rot = _view_matrix(yaw, pitch)
    v = pos @ rot.T
    lo, hi = (np.array(aabb[0]), np.array(aabb[1])) if aabb else (v.min(0), v.max(0))
    center, span = (lo + hi) / 2, max(float((hi - lo).max()), 1e-6) * 1.08
    scale = size / span
    sx = ((v[:, 0] - center[0]) * scale + size / 2).astype(np.int32)
    sy = (size / 2 - (v[:, 1] - center[1]) * scale).astype(np.int32)
    depth = (v[:, 2] - center[2]) * scale

    light = np.array([0.35, 0.55, 0.75])
    light /= np.linalg.norm(light)
    # 顶点色：有 UV 与贴图就采样，否则按位置给中性灰（配合法线缺失，用高度做明暗）
    color = np.full((len(pos), 3), 170, np.float32)
    for t in {int(x) for x in texs if x >= 0}:
        if t not in textures:
            continue
        sel = texs == t
        color[sel] = _tex_lookup(textures[t], uvs[sel])
    shade = 0.72 + 0.28 * np.clip((v[:, 1] - lo[1]) / max(hi[1] - lo[1], 1e-6), 0, 1)
    color = np.clip(color * shade[:, None], 0, 255).astype(np.uint8)

    img = np.full((size, size, 3), 255, np.uint8)
    zbuf = np.full((size, size), -1e18)
    order = np.argsort(depth, kind="stable")  # 升序 → 后写的更近
    rng = range(-splat, splat + 1)
    for dx in rng:
        for dy in rng:
            gx, gy = sx[order] + dx, sy[order] + dy
            ok = (gx >= 0) & (gx < size) & (gy >= 0) & (gy < size)
            if not ok.any():
                continue
            px, py, d = gx[ok], gy[ok], depth[order][ok]
            # 逐像素只保留更近者：先按深度取该位置最大值，再写入对应颜色
            np.maximum.at(zbuf, (py, px), d)
            take = d >= zbuf[py, px] - 1e-9
            zbuf[py[take], px[take]] = d[take]
            img[py[take], px[take]] = color[order][ok][take]
    return img


def render(tris: np.ndarray, uvs: np.ndarray, texs: np.ndarray, textures: dict,
           size: int = 480, yaw: float = -35.0, pitch: float = 20.0,
           aabb: tuple | None = None) -> np.ndarray:
    """逐三角光栅（精渲）：正交投影 + z-buffer + Lambert 平面着色 + 可选 baseColor 采样。"""
    if len(tris) == 0:
        return np.full((size, size, 3), 255, np.uint8)
    rot = _view_matrix(yaw, pitch)
    v = tris @ rot.T
    if aabb is None:
        lo, hi = v.reshape(-1, 3).min(0), v.reshape(-1, 3).max(0)
    else:
        lo, hi = np.array(aabb[0]), np.array(aabb[1])
    center, span = (lo + hi) / 2, max((hi - lo).max(), 1e-6) * 1.08
    scale = size / span
    # 屏幕坐标：x 右，y 上（图像行向下）
    sx = (v[:, :, 0] - center[0]) * scale + size / 2
    sy = size / 2 - (v[:, :, 1] - center[1]) * scale
    sz = (v[:, :, 2] - center[2]) * scale

    color = np.full((size, size, 3), 255, np.uint8)
    zbuf = np.full((size, size), -1e18)
    light = np.array([0.35, 0.55, 0.75])
    light /= np.linalg.norm(light)
    for t in range(len(tris)):
        x0, x1 = int(max(0, np.floor(sx[t].min()))), int(min(size - 1, np.ceil(sx[t].max())))
        y0, y1 = int(max(0, np.floor(sy[t].min()))), int(min(size - 1, np.ceil(sy[t].max())))
        if x1 < x0 or y1 < y0:
            continue
        xs = np.arange(x0, x1 + 1) + 0.5
        ys = np.arange(y0, y1 + 1) + 0.5
        gx, gy = np.meshgrid(xs, ys)
        ax, ay, az = sx[t, 0], sy[t, 0], sz[t, 0]
        bx, by, bz = sx[t, 1], sy[t, 1], sz[t, 1]
        cx, cy, cz = sx[t, 2], sy[t, 2], sz[t, 2]
        d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(d) < 1e-12:
            continue
        w0 = ((by - cy) * (gx - cx) + (cx - bx) * (gy - cy)) / d
        w1 = ((cy - ay) * (gx - cx) + (ax - cx) * (gy - cy)) / d
        w2 = 1 - w0 - w1
        inside = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
        if not inside.any():
            continue
        z = w0 * az + w1 * bz + w2 * cz
        sub = zbuf[y0:y1 + 1, x0:x1 + 1]
        upd = inside & (z > sub)
        if not upd.any():
            continue
        # 颜色：baseColor 采样 或 Lambert 平面着色
        if texs[t] >= 0 and texs[t] in textures:
            img = textures[texs[t]]
            tw, th = img.size
            arr = np.asarray(img.convert("RGB"), dtype=np.float32)
            u = w0 * uvs[t, 0, 0] + w1 * uvs[t, 1, 0] + w2 * uvs[t, 2, 0]
            vv = w0 * uvs[t, 0, 1] + w1 * uvs[t, 1, 1] + w2 * uvs[t, 2, 1]
            px = np.clip((u % 1.0) * (tw - 1), 0, tw - 1).astype(np.int32)
            py = np.clip((vv % 1.0) * (th - 1), 0, th - 1).astype(np.int32)
            rgb = arr[py, px]
            # 乘一层 Lambert 增加立体感
            fn = np.cross(tris[t, 1] - tris[t, 0], tris[t, 2] - tris[t, 0])
            nlen = np.linalg.norm(fn)
            lam = abs(float(fn @ light) / nlen) if nlen > 0 else 0.7
            rgb = rgb * (0.55 + 0.45 * lam)
        else:
            fn = np.cross(tris[t, 1] - tris[t, 0], tris[t, 2] - tris[t, 0])
            nlen = np.linalg.norm(fn)
            lam = abs(float(fn @ light) / nlen) if nlen > 0 else 0.7
            g = int(80 + 150 * lam)
            rgb = np.full((gx.shape[0], gx.shape[1], 3), g, np.float32)
        sub[upd] = z[upd]
        color[y0:y1 + 1, x0:x1 + 1][upd] = np.clip(rgb, 0, 255).astype(np.uint8)[upd]
    return color


def gather_points(js, binc) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """→ (顶点世界坐标 (N,3), 每顶点 UV (N,2), 每顶点 baseColor 贴图 id 或 -1,
    每顶点 MASK 阈值或 -1)。供快渲使用。"""
    nodes, meshes = js.get("nodes", []), js.get("meshes", [])
    mats = js.get("materials", [])
    pos_l, uv_l, tex_l, cut_l = [], [], [], []

    def walk(i: int, parent: np.ndarray) -> None:
        n = nodes[i]
        world = parent @ _mat4(n)
        if "mesh" in n:
            for pr in meshes[n["mesh"]]["primitives"]:
                at = pr["attributes"]
                p = accessor_array(js, binc, at["POSITION"]).astype(np.float64)
                if p.shape[1] == 2:
                    p = np.hstack([p, np.zeros((len(p), 1))])
                p = (world[:3, :3] @ p.T).T + world[:3, 3]
                if "TEXCOORD_0" in at:
                    uv = accessor_array(js, binc, at["TEXCOORD_0"]).astype(np.float64)
                    uv = np.nan_to_num(uv, nan=0.0, posinf=0.0, neginf=0.0)
                else:
                    uv = np.zeros((len(p), 2))
                tex = -1
                cutoff = -1.0
                mi = pr.get("material")
                if mi is not None and mi < len(mats):
                    mat = mats[mi]
                    bt = (mat.get("pbrMetallicRoughness") or {}).get("baseColorTexture")
                    if bt:
                        tex = bt["index"]
                    if mat.get("alphaMode") == "MASK":
                        cutoff = float(mat.get("alphaCutoff", 0.5))
                pos_l.append(p)
                uv_l.append(uv)
                tex_l.append(np.full(len(p), tex, dtype=np.int64))
                cut_l.append(np.full(len(p), cutoff, dtype=np.float64))
        for c in n.get("children", []):
            walk(c, world)

    for r in scene_roots(js):
        walk(r, np.eye(4))
    if not pos_l:
        return (np.zeros((0, 3)), np.zeros((0, 2)),
                np.zeros(0, dtype=np.int64), np.zeros(0))
    return (np.concatenate(pos_l), np.concatenate(uv_l),
            np.concatenate(tex_l), np.concatenate(cut_l))


def render_pair(bk_glb: pathlib.Path, local_glb: pathlib.Path, size: int,
                mode: str = "points", views_only: list | None = None) -> dict:
    bjs, bb = read_glb(bk_glb)
    ljs, lb = read_glb(local_glb)
    if mode == "points":
        bp, bu, btex, bcut = gather_points(bjs, bb)
        lp, lu, ltex, lcut = gather_points(ljs, lb)
        bt, lt = np.zeros((0, 3, 3)), np.zeros((0, 3, 3))
    else:
        bt, bu, btex = gather_triangles(bjs, bb)
        lt, lu, ltex = gather_triangles(ljs, lb)
        bp, lp = bt.reshape(-1, 3), lt.reshape(-1, 3)
        bu, lu = bu.reshape(-1, 2), lu.reshape(-1, 2)
        btex = np.repeat(btex, 3)
        ltex = np.repeat(ltex, 3)
        bcut = lcut = None      # tri 模式不做 alpha 遮罩（见 render 的说明）
    # 同一相机：AABB 取两者并集，保证两张图可直接叠比
    allpts = np.concatenate([bp, lp]) if len(bp) or len(lp) else np.zeros((1, 3))
    lo, hi = allpts.min(0), allpts.max(0)
    views = views_only or [("front-left", -35.0, 20.0), ("side", -90.0, 8.0), ("rear-right", 145.0, 18.0)]
    out = {}
    for name, yaw, pitch in views:
        if mode == "points":
            bimg = render_points(bp, bu, btex, {i: load_texture(bjs, bb, i) for i in set(btex.tolist()) if i >= 0},
                                 size, yaw, pitch, (lo, hi), cutoffs=bcut)
            limg = render_points(lp, lu, ltex, {i: load_texture(ljs, lb, i) for i in set(ltex.tolist()) if i >= 0},
                                 size, yaw, pitch, (lo, hi), cutoffs=lcut)
        else:
            bimg = render(bt, bu.reshape(-1, 3, 2), btex, {i: load_texture(bjs, bb, i) for i in set(btex.tolist()) if i >= 0},
                          size, yaw, pitch, (lo, hi))
            limg = render(lt, lu.reshape(-1, 3, 2), ltex, {i: load_texture(ljs, lb, i) for i in set(ltex.tolist()) if i >= 0},
                          size, yaw, pitch, (lo, hi))
        bmask, lmask = (bimg < 250).any(2), (limg < 250).any(2)
        diff = np.full((size, size, 3), 255, np.uint8)
        both = bmask & lmask
        diff[both] = np.clip(255 - np.abs(bimg[both].astype(int) - limg[both].astype(int)) * 3, 0, 255).astype(np.uint8)
        diff[lmask & ~bmask] = [220, 40, 40]     # 仅本地有
        diff[bmask & ~lmask] = [40, 90, 220]     # 仅 BlitzKit 有
        inter = int((bmask & lmask).sum())
        union = int((bmask | lmask).sum())
        # union==0 说明两边都没渲出像素（渲染器或 GLB 有问题）——不能报成 1.0 的"完全一致"
        out[name] = {"blitzkit": bimg, "local": limg, "diff": diff,
                     "silhouette_iou": round(inter / union, 4) if union else 0.0,
                     "ink": [round(float(bmask.mean()), 4), round(float(lmask.mean()), 4)],
                     "pixel_mad": round(float(np.abs(bimg.astype(int) - limg.astype(int)).mean()), 3),
                     "tris": [len(bt), len(lt)]}
    return out


def _sheet(images: list[list[np.ndarray]], labels: list[list[str]], path: pathlib.Path) -> None:
    """把二维图像网格写成一个 PNG（每格下方留标签白条）。"""
    from PIL import Image, ImageDraw
    rows, cols = len(images), len(images[0])
    h, w = images[0][0].shape[:2]
    pad, bar = 6, 22
    W, H = cols * (w + pad) + pad, rows * (h + bar + pad) + pad
    sheet = Image.new("RGB", (W, H), (255, 255, 255))
    dr = ImageDraw.Draw(sheet)
    for r in range(rows):
        for c in range(cols):
            x, y = pad + c * (w + pad), pad + r * (h + bar + pad)
            sheet.paste(Image.fromarray(images[r][c]), (x, y))
            dr.text((x + 4, y + h + 4), labels[r][c], fill=(0, 0, 0))
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path)


def render_one(args: tuple) -> dict:
    tank_id, bk_root, local_root, out_dir, size, mode = args
    bk, lc = bk_root / str(tank_id) / "model.glb", local_root / str(tank_id) / "model.glb"
    if not bk.exists() or not lc.exists():
        return {"tank_id": tank_id, "status": "no-blitzkit" if not bk.exists() else "no-local"}
    rep = {"tank_id": tank_id, "status": "ok", "mode": mode, "views": {}}
    try:
        views = render_pair(bk, lc, size, mode)
    except Exception as e:  # noqa: BLE001
        return {"tank_id": tank_id, "status": "error", "error": f"{type(e).__name__}: {e}"}
    imgs, labels = [], []
    for name, v in views.items():
        rep["views"][name] = {k: v[k] for k in ("silhouette_iou", "ink", "pixel_mad", "tris")}
        imgs.append([v["blitzkit"], v["local"], v["diff"]])
        labels.append([f"BlitzKit | {name}", f"local | {name}", "diff (red=local-only, blue=BK-only)"])
    # 转置成 [三视图 × 3 列]
    grid = [[imgs[i][j] for j in range(3)] for i in range(3)]
    grid_labels = [[labels[i][j] for j in range(3)] for i in range(3)]
    _sheet(grid, grid_labels, out_dir / f"{tank_id}_compare.png")
    rep["sheet"] = str(out_dir / f"{tank_id}_compare.png")
    return rep


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--tank", action="append", default=[])
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--blitzkit-dir", type=pathlib.Path, default=pathlib.Path("data/cache/models"))
    ap.add_argument("--local-dir", type=pathlib.Path, default=pathlib.Path("data/cache/local_models"))
    ap.add_argument("--out-dir", type=pathlib.Path, default=pathlib.Path("data/cache/local_compare"))
    ap.add_argument("--audit", action="store_true", help="数值等价回归")
    ap.add_argument("--render", action="store_true", help="并排渲染对比")
    ap.add_argument("--size", type=int, default=480)
    ap.add_argument("--render-mode", choices=["points", "tri"], default="points",
                    help="points=向量化顶点泼溅（快，默认）；tri=逐三角光栅（慢但边缘精确）")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--report", type=pathlib.Path, default=None)
    args = ap.parse_args()

    if args.all:
        ids = sorted(int(p.name) for p in args.local_dir.iterdir()
                     if p.is_dir() and p.name.isdigit())
    elif args.tank:
        ids = [int(t) for t in args.tank]
    else:
        print("!! 需要 --tank <id> 或 --all", file=sys.stderr)
        return 2
    if not (args.audit or args.render):
        args.audit = True

    report: dict = {"tanks": ids, "audit": None, "render": None}

    if args.audit:
        payloads = [(tid, args.blitzkit_dir, args.local_dir) for tid in ids]
        rows = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
            for r in pool.map(audit_one, payloads):
                rows.append(r)
        stat: dict = {}
        for r in rows:
            for art in ("model.glb", "collision.glb"):
                a = r.get(art, {})
                stat.setdefault(art, {}).setdefault(a.get("status", "?"), 0)
                stat[art][a.get("status", "?")] += 1
        diffs = [{"tank_id": r["tank_id"], "art": art,
                  **{k: r[art][k] for k in ("only_blitzkit", "only_local", "diff_counts",
                                            "diff_position", "diff_normal", "diff_uv",
                                            "diff_index_values", "verts", "indices")
                     if k in r[art]}}
                 for r in rows for art in ("model.glb", "collision.glb")
                 if r.get(art, {}).get("status") == "diff"]
        report["audit"] = {"summary": stat, "diffs": diffs}
        for art, s in stat.items():
            total = sum(v for k, v in s.items() if k in ("equal", "diff"))
            eq = s.get("equal", 0)
            print(f"[audit] {art}: 等价 {eq}/{total}"
                  + (f"（不一致 {s.get('diff', 0)}）" if s.get("diff") else "")
                  + f"  其它状态: { {k: v for k, v in s.items() if k not in ('equal', 'diff')} }")
        print(f"[audit] 不一致条目 {len(diffs)}")

    if args.render:
        payloads = [(tid, args.blitzkit_dir, args.local_dir, args.out_dir, args.size, args.render_mode)
                    for tid in ids]
        rows = []
        with concurrent.futures.ProcessPoolExecutor(max_workers=args.jobs) as pool:
            for r in pool.map(render_one, payloads):
                rows.append(r)
        report["render"] = rows
        for r in rows:
            if r["status"] != "ok":
                print(f"[render] {r['tank_id']}: {r['status']} {r.get('error', '')}")
                continue
            ious = [v["silhouette_iou"] for v in r["views"].values()]
            mads = [v["pixel_mad"] for v in r["views"].values()]
            print(f"[render] {r['tank_id']}: IoU {min(ious):.3f}..{max(ious):.3f}  "
                  f"MAD {min(mads):.1f}..{max(mads):.1f}  → {r['sheet']}")

    out = args.report or (args.out_dir / "compare_report.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"[report] {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
