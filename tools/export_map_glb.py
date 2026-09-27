#!/usr/bin/env python3
"""按 WoT Blitz 客户端自身的加载方式导出地图静态场景（GLB + 地面贴图 + 元数据）。

管线与客户端一致（证据见各函数 docstring）：
  1. 注册表：Data/maps.yaml（回放数字 id → localName=space/sc2 路径）联查
     Data/Strings/en.yaml 的 `#maps:<dir>:<space>/<space>.sc2: "<显示名>"` 得到
     minimap 目录与本地化显示名——与客户端 arenaTypeID → maps.yaml 同一条链；
  2. 场景：3d/Maps/<space>/<space>.sc2（DAVA SceneFileV2 + KeyedArchive）实体树；
     实例收集镜像 RenderObject::UpdateActiveRenderBatchesFromCollection 语义
     （ro.flags bit0 可见位、rbN.lodIndex/rbN.switchIndex 与目标 LOD/开关态匹配，
     -1 为通配；开关态取 StateSwitcherComponent.activeState 初始值）；
  3. 几何：rb.datasource → 同名 .scg（SCPG）PolygonGroup 顶点/索引流；
  4. 材质：rb.nmatname → .sc2 #dataNodes 的 NMaterial 节点，沿 parentMaterialKey
     继承链合并贴图槽（albedo/lightmap/colorTexture/...）——贴图按客户端真实
     路径解析，不做任何名字猜测；
  5. 贴图解码：.dx11.dds.dvpl（BC1/2/3）与 .dx11.pvr.dvpl（DAVA 自有 PVR3 容器，
     未压缩 RGBA4444 + mipmap 链，含 CRC_ 子块）；
  6. 地形尺度：Landscape 渲染对象 bbox（世界包围盒）给出 span/zmin/zmax，
     连同注册表信息写入 <space>.json sidecar，供后端 terrain 接口使用。

输出（output-dir，默认 glb_cache/maps/，按 space 目录命名——同一 space 的多张
变体地图共用一份场景）：
    <space>.glb           静态场景（游戏世界系，米，z 上；材质含真贴图/透明树叶）
    <space>.ground.webp   地面烘焙贴图（4096²，客户端 tilemask-fp.sl 公式，上=+z/北）
    <space>.ground.{cm,tile,mask,hmap}.webp + .layers.json
                          分层地表（原始行序）：前端按客户端着色器实时合成，
                          tile 原生分辨率平铺——清晰度对齐客户端
    <space>.grass.bin     草地密度位图（128×128，0/1）
    <space>.json          元数据（注册表 + 地形尺度 + 统计）
前端用 qFrame（Ry(π)·Rx(-π/2)）旋到回放场景系，与坦克 GLB 同一约定。

用法：
    python tools/export_map_glb.py                     # 导出全部（按 space 去重，并行 jobs=4）
    python tools/export_map_glb.py --map WinterMalinovka --map 5
    python tools/export_map_glb.py --ground-only --map Mines
    python tools/export_map_glb.py --jobs 8            # 调整并行进程数

进度：每张图完成即实时打印（含剩余时间估算），并原子更新
<output-dir>/_export_status.json（total/done/failed/finished/results）——
外部可随时读取该文件查询导出是否完成，无需等待进程退出。
"""

from __future__ import annotations

import argparse
import bisect
import concurrent.futures
import io
import json
import math
import pathlib
import random
import re
import struct
import sys
import time

import numpy as np

TOOLS_DIR = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS_DIR / "wotbtools"))

try:
    import imagecodecs
except ImportError:  # 地面贴图/DDS 解码需要
    imagecodecs = None

try:
    from PIL import Image
except ImportError:
    Image = None

from wotb_sc2 import Reader, decode_dvpl, read_archive, read_sc2  # noqa: E402
from wotb_scg import (  # noqa: E402
    decode_bytes,
    decode_polygon_indices,
    decode_polygon_positions,
    read_scg,
)

# ---------------------------------------------------------------------------
# 注册表：maps.yaml（id → localName）+ en.yaml #maps:（dir → sc2/显示名）
# ---------------------------------------------------------------------------


class MapEntry:
    """一张可玩地图的客户端注册信息。"""

    def __init__(self, map_id: int, key: str, local_name: str,
                 minimap_dir: str | None, display: str | None):
        self.map_id = map_id
        self.key = key
        self.local_name = local_name              # "12_malinovka_ma/12_malinovka_ma.sc2"
        self.space = local_name.split("/")[0]     # 3d/Maps 下的目录
        self.minimap_dir = minimap_dir            # Gfx/UI/BattleScreenHUD/minimap/<dir>
        self.display = display or key

    def __repr__(self) -> str:
        return f"MapEntry({self.map_id}, {self.key!r}, {self.space})"


def _parse_maps_yaml(text: str) -> dict[int, tuple[str, str]]:
    """maps.yaml 最小行解析：`    <key>:` 下的 `id:` / `localName:`。返回 id → (key, localName)。"""
    out: dict[int, tuple[str, str]] = {}
    key = None
    entry_id = None
    for line in text.splitlines():
        m = re.match(r"^    ([A-Za-z0-9_]+):\s*$", line)
        if m:
            key, entry_id = m.group(1), None
            continue
        m = re.match(r"^\s+id:\s*(\d+)\s*$", line)
        if m and key:
            entry_id = int(m.group(1))
            continue
        m = re.match(r"^\s+localName:\s*\"?([^\"\s]+)\"?\s*$", line)
        if m and key and entry_id is not None:
            out[entry_id] = (key, m.group(1))
    return out


def _parse_en_yaml_maps(text: str) -> dict[str, list[tuple[str, str]]]:
    """en.yaml 的 `\"#maps:<dir>:<space>/<space>.sc2\": \"<显示名>\"` 条目。

    同一 sc2 路径可能有多条（rudniki / rudniki_01/02/03 出生点变体），全部收集。
    """
    out: dict[str, list[tuple[str, str]]] = {}
    for m in re.finditer(r'"#maps:([^:]+):([^"]+)":\s*"([^"]*)"', text):
        out.setdefault(m.group(2), []).append((m.group(1), m.group(3)))
    return out


def load_registry(game_data: pathlib.Path) -> list[MapEntry]:
    """联查两张客户端表得到全量注册信息（与客户端 arenaTypeID→maps.yaml 同链）。

    显示名取 en.yaml 中 dir 与 maps.yaml 键一致的条目（基础变体），无则取首条。
    """
    maps_text = decode_dvpl((game_data / "maps.yaml.dvpl").read_bytes()).decode("utf-8", "replace")
    en_text = decode_dvpl(
        (game_data / "Strings" / "en.yaml.dvpl").read_bytes()).decode("utf-8", "replace")
    by_sc2 = _parse_en_yaml_maps(en_text)
    entries = []
    for map_id, (key, local_name) in sorted(_parse_maps_yaml(maps_text).items()):
        variants = by_sc2.get(local_name, [])
        pick = next((v for v in variants if v[0] == key), variants[0] if variants else None)
        dir_name, display = pick if pick else ("", "")
        entries.append(MapEntry(map_id, key, local_name, dir_name or None, display or None))
    return entries


def resolve_entry(entries: list[MapEntry], name: str) -> MapEntry | None:
    """解析 CLI/请求参数：纯数字=回放地图 id；否则显示名/键（去空白归一）。"""
    s = name.strip()
    if s.isdigit():
        for e in entries:
            if e.map_id == int(s):
                return e
        return None

    def norm(x: str) -> str:
        return re.sub(r"[^A-Za-z0-9]", "", x).lower()

    for e in entries:
        if norm(e.display) == norm(s):
            return e
    for e in entries:
        if norm(e.key) == norm(s):
            return e
    return None


# ---------------------------------------------------------------------------
# 场景/几何/材质（客户端格式，解析复用 tools/wotbtools）
# ---------------------------------------------------------------------------


MAGIC_PREFIX = b"PVR" + bytes([3])
MAGIC_MARKER = MAGIC_PREFIX + b"CRC_"


def extract_string_table(raw: bytes) -> dict[int, str]:
    """SC2 KeyedArchive 头部的 fastname 字符串表（id → 字符串）。"""
    reader = Reader(raw)
    reader.take(4)
    reader.u32(), reader.u32()
    read_archive(reader)
    desc = reader.u32()
    reader.take(desc)
    reader.take(2)
    ver = reader.u16()
    if ver != 2:
        return {}
    n = reader.u32()
    strings = [reader.text(reader.u16()) for _ in range(n)]
    ids = [reader.u32() for _ in range(n)]
    return dict(zip(ids, strings, strict=True))


def iter_entities_recursive(container: dict, path: str = "$"):
    """深先序遍历实体树（含嵌套 #hierarchy），镜像客户端场景节点遍历。"""
    hierarchy = container.get("#hierarchy")
    if not isinstance(hierarchy, list):
        return
    for index, entity in enumerate(hierarchy):
        if not isinstance(entity, dict):
            continue
        entity_path = f"{path}.#hierarchy[{index}]"
        yield entity_path, entity
        yield from iter_entities_recursive(entity, entity_path)


def components_of(entity: dict) -> list[dict]:
    comps = entity.get("components")
    if not isinstance(comps, dict):
        return []
    return [c for c in comps.values() if isinstance(c, dict)]


def component_by_type(entity: dict, type_name: str) -> dict | None:
    return next((c for c in components_of(entity) if c.get("comp.typename") == type_name), None)


def world_transform(entity: dict) -> dict:
    """TransformComponent 里客户端已烘焙的世界变换（与父链累乘等价）。"""
    t = component_by_type(entity, "TransformComponent") or {}
    vec = lambda key, n, default: ([float(x) for x in t[key]]
                                   if isinstance(t.get(key), list) and len(t[key]) == n
                                   else list(default))
    return {
        "translation": vec("tc.worldTranslation", 3, (0.0, 0.0, 0.0)),
        "scale": vec("tc.worldScale", 3, (1.0, 1.0, 1.0)),
        "rotation": vec("tc.worldRotation", 4, (0.0, 0.0, 0.0, 1.0)),
    }


RENDER_OBJECT_VISIBLE_FLAG = 1 << 0
SHARED_BATCH_INDEX = -1
# 导出的 LOD/开关目标：初始可见态（客户端进场即 LOD0、StateSwitcher 处于 activeState）
TARGET_LOD = 0
# SpeedTree 远景 billboard（crossed-plane impostor）贴图命名约定（全图库扫描证实）：
# *_planes.tex / *_bb_*.tex / planelod*.tex
IMPOSTOR_TEX_RE = re.compile(r"(?i)planes|_bb_|planelod")
# SpeedTree 远景 LOD 平贴卡片的贴图命名（a_bush1_low1-4 / bush02_low1-2 等实测）
LOD_CARD_TEX_RE = re.compile(r"(?i)_low\d|_low\.")


class MaterialLibrary:
    """.sc2 #dataNodes 的 NMaterial 节点库 + parentMaterialKey 继承链解析。"""

    def __init__(self, scene: dict):
        self.by_id: dict[int, dict] = {}
        for node in scene.get("#dataNodes") or []:
            if not isinstance(node, dict) or node.get("##name") != "NMaterial":
                continue
            raw = node.get("#id")
            if not (isinstance(raw, dict) and isinstance(raw.get("$bytes"), str)):
                continue
            try:
                node_id = struct.unpack("<Q", bytes.fromhex(raw["$bytes"]))[0]
            except ValueError:
                continue
            self.by_id[node_id] = node
        self._cache: dict[int, dict] = {}

    def resolve(self, material_id: int | None) -> dict:
        """沿 parentMaterialKey 向上合并：贴图槽/属性子覆盖父，fxName 取最近非空。"""
        if material_id is None:
            return {}
        if material_id in self._cache:
            return self._cache[material_id]
        merged: dict = {"textures": {}, "properties": {}, "flags": {}, "fxName": None, "materialName": None}
        seen: set[int] = set()
        cur: int | None = material_id
        while isinstance(cur, int) and cur not in seen:
            seen.add(cur)
            node = self.by_id.get(cur)
            if node is None:
                break
            merged["textures"].update(node.get("textures") or {})
            merged["properties"].update(node.get("properties") or {})
            merged["flags"].update(node.get("flags") or {})
            if merged["fxName"] is None and node.get("fxName"):
                merged["fxName"] = node["fxName"]
            if merged["materialName"] is None and node.get("materialName"):
                merged["materialName"] = node["materialName"]
            cur = node.get("parentMaterialKey") if isinstance(node.get("parentMaterialKey"), int) else None
        self._cache[material_id] = merged
        return merged


def collect_renderables(scene: dict) -> dict:
    """按客户端批次激活规则收集场景内容。

    返回 {
      instances: [(entity_name, world_transform, datasource, material_id, path, cls)],
      landscape: {...} | None,      # bbox/heightmap/matname
      grass: {...} | None,          # 模板几何 + 密度位图
    }
    """
    instances: list = []
    landscape = None
    grass = None
    lod_batch_dropped = 0

    for entity_path, entity in iter_entities_recursive(scene):
        render = component_by_type(entity, "RenderComponent")
        if render is None:
            continue
        ro = render.get("rc.renderObj")
        if not isinstance(ro, dict):
            continue
        cls = str(ro.get("##name", ""))

        # 实体级初始可见性：bit0/bit1 为隐藏（blocking_volume=1、摧毁态 State-1=2）；
        # 值 4（草地系统实体）客户端照常渲染
        if entity.get("visibility", 0) & 3:
            continue

        # 雾体积（如 malinovka fog_ma01.sc2）：客户端经雾管线渲染成半透明，
        # 静态导出会变成罩住半张图的白色实体网格——跳过
        if "fog" in str(name := entity.get("name") or "").lower():
            continue

        # StateSwitcher 的高状态子树（"SwitchNode State 1/2"＝损毁/变体形态）：
        # 初始态为 0，其 batch switchIndex 缺省通配时会漏进来叠在完整形态上
        if re.search(r"State [1-9]", str(entity.get("name") or "")):
            continue

        if cls == "Landscape":
            bbox = ro.get("bbox")
            hmap = ro.get("hmap")
            matname = ro.get("matname")
            entry = {}
            if isinstance(bbox, dict) and isinstance(bbox.get("$bytes"), str):
                try:
                    vals = struct.unpack("<6f", bytes.fromhex(bbox["$bytes"]))
                    entry["worldBounds"] = {"min": list(vals[:3]), "max": list(vals[3:])}
                except ValueError:
                    pass
            if isinstance(hmap, str):
                entry["heightmap"] = hmap
            if isinstance(matname, int):
                entry["matname"] = matname
            landscape = entry or None
            continue

        if cls == "VegetationRenderObject":
            candidate = _collect_grass(ro)
            if candidate:
                if grass is None:
                    grass = candidate
                else:
                    # 模板取最高精细度档（顶点数最多，如 500k HIGH 档）；密度位图取首个可用值
                    old_t = grass.get("template")
                    new_t = candidate.get("template")
                    if new_t and (not old_t or len(new_t["positions"]) > len(old_t["positions"])):
                        grass["template"] = new_t
                    grass.setdefault("density", candidate.get("density"))
            continue

        if cls not in ("Mesh", "SpeedTreeObject"):
            continue  # MapBorderRenderObject 等调试/边框对象

        # RenderObject 可见位（缺省即可见，镜像 RenderObject::Load 序列化缺省）
        flags = ro.get("ro.flags")
        if isinstance(flags, int) and not (flags & RENDER_OBJECT_VISIBLE_FLAG):
            continue
        if ro.get("ro.notShadowOnly") is False:
            continue

        switcher = component_by_type(entity, "StateSwitcherComponent")
        active_switch = switcher.get("ssc.activeState", 0) if switcher else 0
        if not isinstance(active_switch, int):
            active_switch = 0

        name = entity.get("name")
        transform = world_transform(entity)
        batches = ro.get("ro.batches")
        if not isinstance(batches, dict):
            continue
        batch_items = sorted(batches.items())
        # 客户端 RenderObject 按 rbN.lodIndex（N 为去零填充的批号，如 rb0/rb7，
        # 与批字典键 "0000" 不同——此前误用补零键导致恒读不到、全按通配处理）
        # 距离切换 LOD；实测 lod0 = 最高精度（fir: b0-2=完整组；电线杆
        # 210v=lod0/144v=lod1/28v=lod2）。非 SpeedTree 实体只保留 LOD0 批；
        # SpeedTree 的 lod 组选择交由 export_map 的顶点量择优。
        if cls != "SpeedTreeObject":
            lod_comp = component_by_type(entity, "LodComponent")
            if lod_comp is not None and len(batch_items) > 1:
                lod_filtered = [(k, b) for k, b in batch_items
                                if ro.get(f"rb{int(k)}.lodIndex", SHARED_BATCH_INDEX)
                                in (TARGET_LOD, SHARED_BATCH_INDEX)]
                batch_items = lod_filtered or batch_items[:1]
                lod_batch_dropped += max(0, len(batches) - len(batch_items))
        for batch_index, batch in batch_items:
            if not isinstance(batch, dict):
                continue
            bi_num = int(batch_index)
            lod = ro.get(f"rb{bi_num}.lodIndex", SHARED_BATCH_INDEX)
            switch = ro.get(f"rb{bi_num}.switchIndex", SHARED_BATCH_INDEX)
            # SpeedTree 的 lod 不过滤（_low 变体的卡片组在 lod1 而非 lod0），
            # 全部放行给 export_map 的"总顶点量最大 lod 组"择优；非 SpeedTree
            # 按 LOD0/通配过滤
            if cls != "SpeedTreeObject" and lod not in (TARGET_LOD, SHARED_BATCH_INDEX):
                continue
            if switch not in (active_switch, SHARED_BATCH_INDEX):
                continue
            datasource = batch.get("rb.datasource")
            if not isinstance(datasource, int):
                continue
            material_id = batch.get("rb.nmatname")
            # SpeedTree 的 SH 环境光 L0（speedtree-materials-fp.sl:
            # baseColor *= varVertexColor，SH 仅 L0 常数实测）→ 材质染色
            sh_l0 = None
            if cls == "SpeedTreeObject":
                sh = ro.get("sto.SHCoeff")
                if isinstance(sh, dict) and isinstance(sh.get("$bytes"), str):
                    try:
                        sh_l0 = struct.unpack("<f", bytes.fromhex(sh["$bytes"])[:4])[0]
                    except (ValueError, struct.error):
                        pass
            instances.append((name, transform, datasource,
                              material_id if isinstance(material_id, int) else None,
                              entity_path, cls, lod, sh_l0))
    return {"instances": instances, "landscape": landscape, "grass": grass,
            "lod_batches_dropped": lod_batch_dropped}


def _collect_grass(ro: dict) -> dict | None:
    """VegetationRenderObject：内嵌草丛模板几何（cgd 全部 variation × 最高档
    lod.0）+ 密度位图。

    客户端草系统按 cgd.variationsCount 个变体轮换密集铺设（每变体取 lod.0
    即最高精细档，posCount 沿 lod 序递减实测）；静态导出全部变体供前端
    实例化时轮换，避免单一变体重复铺出的机械感。
    """
    out: dict = {}
    gd = ro.get("vro.geometryData")
    chunk = gd.get("cgd.chunkSet") if isinstance(gd, dict) else None
    templates = []
    if isinstance(chunk, dict):
        for vkey in sorted(chunk.keys()):
            if not vkey.startswith("cgd.variation."):
                continue
            var = chunk[vkey]
            lod0 = var.get("cgd.lod.0") if isinstance(var, dict) else None
            if not isinstance(lod0, dict):
                continue
            pc, ic = lod0.get("cgd.lod.posCount"), lod0.get("cgd.lod.indexCount")
            if isinstance(pc, int) and isinstance(ic, int) and pc > 0 and ic > 0:
                positions = [[float(x) for x in lod0.get(f"cgd.lod.pos.{i}", (0, 0, 0))] for i in range(pc)]
                uvs = [[float(x) for x in lod0.get(f"cgd.lod.tex.{i}", (0, 0))]
                       for i in range(lod0.get("cgd.lod.texCoordCount") or 0)]
                indices = [int(lod0.get(f"cgd.lod.index.{i}", 0)) for i in range(ic)]
                templates.append({"positions": positions, "uvs": uvs, "indices": indices})
    if templates:
        out["templates"] = templates
        out["template"] = max(templates, key=lambda t: len(t["positions"]))
    dm = ro.get("vro.flippedDensityMap")
    if isinstance(dm, dict) and isinstance(dm.get("$bytes"), str):
        data = bytes.fromhex(dm["$bytes"])
        side = int(math.isqrt(len(data)))
        if side * side == len(data) and side >= 16:
            out["density"] = np.frombuffer(data, dtype=np.uint8).reshape(side, side).copy()
    # 草材质参数（grass-fp.sl：albedo × lightmap × baseColorMultiplier，isLit=false）
    if isinstance(ro.get("vro.lightmap"), str):
        out["lightmap"] = ro["vro.lightmap"]
    if isinstance(ro.get("vro.baseColorMultilplier"), (int, float)):
        out["color_mult"] = float(ro["vro.baseColorMultilplier"])
    return out or None


# 顶点布局（SCG 交错顶点，实测 7 种 vertexFormat 反推，bit 求和 == stride）
VERTEX_LAYOUT_BITS = {0: 12, 1: 12, 2: 4, 3: 8, 4: 8, 7: 12, 8: 12, 9: 16, 10: 8, 12: 12, 13: 16}


def decode_group_uvs(group: dict):
    """解出 UV0（bit3）与 UV1（bit4）。

    客户端 materials-fp.sl：albedo 采样 texCoord0；ALPHA_MASK 材质的
    alphamask（效果层镂空）采样 texCoord1。偏移按低于 UV 位的功能位累计——
    普通网格位和恒等于 stride；SpeedTree 卡片组高位语义不同导致位和≠stride，
    但 UV 仍在低位累计偏移处。
    返回 (uv0, uv1或None, 使用的通道bit)；无有效 UV → None。
    """
    vf = group.get("vertexFormat")
    vc = group.get("vertexCount")
    payload = decode_bytes(group.get("vertices"))
    if not isinstance(vf, int) or not isinstance(vc, int) or vc <= 0 or payload is None:
        return None
    stride, rem = divmod(len(payload), vc)
    if rem or stride < 12:
        return None
    low_off = 0
    for b in range(3):
        if vf >> b & 1:
            sz = VERTEX_LAYOUT_BITS.get(b)
            if sz is None:
                return None
            low_off += sz
    arr = np.frombuffer(payload, dtype=np.uint8).reshape(vc, stride)
    floats = arr.view("<f4")
    found = {}
    for bit in (3, 4):
        if not (vf >> bit) & 1:
            continue
        uv_off = low_off + (0 if bit == 3 else VERTEX_LAYOUT_BITS[3])
        if uv_off + 8 > stride:
            continue
        u = floats[:, uv_off // 4]
        v = floats[:, uv_off // 4 + 1]
        if not (np.isfinite(u).all() and np.isfinite(v).all()):
            continue
        if max(abs(float(u.max())), abs(float(v.max()))) > 64:
            continue
        found[bit] = list(zip(u.tolist(), v.tolist()))
    if 3 in found:
        return found[3], found.get(4), 3
    if 4 in found:
        return found[4], None, 4
    return None


def strip_to_triangles(seq: list[int]) -> list[int]:
    """三角条带 → 三角形列表（标准交替绕序；退化三角形剔除）。"""
    out: list[int] = []
    for i in range(2, len(seq)):
        a, b, c = seq[i - 2], seq[i - 1], seq[i]
        if a == b or b == c or a == c:
            continue
        out.extend((a, b, c) if i % 2 == 0 else (a, c, b))
    return out


def fan_to_triangles(seq: list[int]) -> list[int]:
    """三角扇 → 三角形列表。"""
    return [x for i in range(1, len(seq) - 1) for x in (seq[0], seq[i], seq[i + 1])]


def group_triangles(group: dict, indices: list[int]) -> list[int] | None:
    """图元索引统一为三角形（primitiveCount 算术自洽判别条带/列表）。"""
    ic = len(indices)
    pc = group.get("primitiveCount")
    ptype = group.get("rhi_primitiveType")
    if isinstance(pc, int):
        if pc == ic // 3 and ic % 3 == 0:
            return indices
        if pc == ic - 2:
            return strip_to_triangles(indices)
    if ptype in (None, 0):
        return indices
    if ptype == 1 and ic >= 3:
        return strip_to_triangles(indices)
    if ptype == 4 and ic >= 3:
        return fan_to_triangles(indices)
    return indices if ic % 3 == 0 else None


def compute_normals(positions, indices):
    """平滑顶点法线（面积加权）。"""
    normals = [[0.0, 0.0, 0.0] for _ in positions]
    for i in range(0, len(indices) - 2, 3):
        a, b, c = indices[i], indices[i + 1], indices[i + 2]
        ax, ay, az = positions[a]
        bx, by, bz = positions[b]
        cx, cy, cz = positions[c]
        nx, ny, nz = (by - ay) * (cz - az) - (bz - az) * (cy - ay), \
                     (bz - az) * (cx - ax) - (bx - ax) * (cz - az), \
                     (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
        for j in (a, b, c):
            normals[j][0] += nx
            normals[j][1] += ny
            normals[j][2] += nz
    out = []
    for n in normals:
        length = math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2)
        out.append((n[0] / length, n[1] / length, n[2] / length) if length > 1e-12 else (0.0, 1.0, 0.0))
    return out


# ---------------------------------------------------------------------------
# 贴图解码：DDS（BC1/2/3）与 DAVA PVR3（RGBA4444）
# ---------------------------------------------------------------------------

DDS_FOURCC_TO_BCN = {"DXT1": 1, "DXT3": 2, "DXT5": 3}


def decode_dds(d: bytes, max_dim: int = 1024) -> Image.Image | None:
    """DDS（DXT1/3/5）→ PIL RGBA，保留 alpha，长边超限等比缩小。"""
    if d[:4] != b"DDS ":
        return None
    height = struct.unpack_from("<I", d, 12)[0]
    width = struct.unpack_from("<I", d, 16)[0]
    bcn = DDS_FOURCC_TO_BCN.get(d[84:88].decode(errors="replace"))
    if bcn is None or imagecodecs is None:
        return None
    block = 8 if bcn == 1 else 16
    data = d[128:128 + (width // 4) * (height // 4) * block]
    rgba = imagecodecs.bcn_decode(data, bcn, shape=(height, width, 4))
    img = Image.frombytes("RGBA", (width, height), rgba).transpose(Image.FLIP_TOP_BOTTOM)
    if max(img.size) > max_dim:
        img.thumbnail((max_dim, max_dim), Image.LANCZOS)
    return img


def decode_pvr3(d: bytes, max_dim: int = 1024) -> Image.Image | None:
    """DAVA 自有 PVR3 容器 → PIL RGBA。

    布局（客户端多张纹理实测）：48B 头（PVR3/ver/'rgba'/bits[4]/0/0/w/h/1,1,1/mips/0x1f）
    + PVR3 | 3 | 3 | 00 00 00 | PVR3 'CRC_' len crc | 像素（未压缩 mip 链，mip0 在前）。
    像素起点按 CRC_ 子块定位；尺寸/位深按"载荷长度与 mip 链总量精确相等"校验，
    头部尺寸字段与载荷不符时（如 TileTxRock 头写 512²、载荷实为 1024² 图集）
    以 2 倍尺寸重试。
    """
    if d[:4] != b"PVR":
        return None
    fmt = d[8:12]
    bits = tuple(d[12:16])
    w0 = struct.unpack_from("<I", d, 24)[0]
    h0 = struct.unpack_from("<I", d, 28)[0]
    mips = max(1, struct.unpack_from("<I", d, 44)[0])
    bpp = sum(bits) // 8 or 2

    def chain(tw, th):
        total, cw, ch = 0, tw, th
        for _ in range(mips):
            total += cw * ch * bpp
            if cw == 1 and ch == 1:
                break
            cw = max(1, cw // 2)
            ch = max(1, ch // 2)
        return total

    starts = []
    marker = d.rfind(b"PVRCRC_")
    if marker != -1:
        head_len = struct.unpack_from("<I", d, marker + 8)[0]
        starts.append(marker + 12 + head_len)
    starts.append(len(d) - chain(w0, h0))

    px = None
    w = h = 0
    for tw, th in ((w0, h0), (w0 * 2, h0 * 2), (w0 * 4, h0 * 4)):
        total = chain(tw, th)
        for start in starts:
            if 0 <= start and len(d) - start == total:
                px = d[start:]
                w, h = tw, th
                break
        if px is not None:
            break
    if px is None or len(px) < w * h * bpp:
        return None

    if bits == (4, 4, 4, 4) and fmt == b"rgba":
        arr = np.frombuffer(px[:w * h * 2], dtype="<u2").reshape(h, w)
        channels = [((arr >> s) & 0xF) * 17 for s in (12, 8, 4, 0)]
    elif bits == (8, 8, 8, 8):
        arr = np.frombuffer(px[:w * h * 4], dtype=np.uint8).reshape(h, w, 4)
        channels = [arr[..., i] for i in range(4)]
    else:
        return None
    rgba = np.stack(channels, axis=-1).astype(np.uint8)
    img = Image.frombytes("RGBA", (w, h), rgba.tobytes()).transpose(Image.FLIP_TOP_BOTTOM)
    if max(img.size) > max_dim:
        img.thumbnail((max_dim, max_dim), Image.LANCZOS)
    return img


def decode_tiletx_planes(d: bytes):
    """解码 TileTx*.tex（四平面打包的地表细节纹理）→ [4 张 512² 灰度细节图]。

    载荷 = 4 个平面顺序存储，每平面 = 单通道 4444 mip 链（512² 时 699050B）。
    """
    if d[:4] != b"PVR":
        return None
    w0 = struct.unpack_from("<I", d, 24)[0]
    h0 = struct.unpack_from("<I", d, 28)[0]
    mips = max(1, struct.unpack_from("<I", d, 44)[0])

    def chain(tw, th):
        total, cw, ch = 0, tw, th
        for _ in range(mips):
            total += cw * ch * 2
            if cw == 1 and ch == 1:
                break
            cw = max(1, cw // 2)
            ch = max(1, ch // 2)
        return total

    per = chain(w0, h0)
    marker = d.rfind(b"PVRCRC_")
    px_start = None
    if marker != -1:
        head_len = struct.unpack_from("<I", d, marker + 8)[0]
        cand = marker + 12 + head_len
        if len(d) - cand == per * 4:
            px_start = cand
    if px_start is None:
        cand = len(d) - per * 4
        px_start = cand if cand >= 0 else None
    if px_start is None:
        return None
    px = d[px_start:]
    planes = []
    for k in range(4):
        plane = np.frombuffer(px[per * k:per * k + chain(w0, h0)], dtype="<u2")
        arr = plane[:w0 * h0].reshape(h0, w0)
        v = ((arr >> 12) & 0xF) * 17  # 取高 4 位作灰度（4444 单通道展宽）
        planes.append(v.astype(np.uint8)[::-1].copy())
    return planes


class TextureStore:
    """`.tex` 逻辑路径 → 已解码图像 + alpha 判定（磁盘变体：dx11.dds / dx11.pvr）。"""

    def __init__(self, map_dir: pathlib.Path, global_dirs: list[pathlib.Path]):
        self.roots = [map_dir, *global_dirs]
        self._cache: dict[str, tuple[Image.Image | None, bool]] = {}
        # 颜色均值兜底（UV 缺失时给材质一个从贴图派生的底色）
        self.avg_color: dict[str, tuple[float, float, float] | None] = {}
        # 源容器为 DDS 的贴图：decode_dds 内部做过一次垂直翻转（row0=authored
        # bottom），嵌入 GLB 前需翻回（glTF v=0 ↔ row0；客户端对 DDS 的 v=0 =
        # authored top，D3D 约定——地面烘焙链路已对 colormap 逐像素验证）。
        # PVR 源经 tileMask 验证为"解码即对"，保持原样。
        self.from_dds: dict[str, bool] = {}

    def _candidates(self, tex_path: str) -> list[pathlib.Path]:
        stem = tex_path[:-4] if tex_path.lower().endswith(".tex") else tex_path
        rel = stem[3:] if stem.startswith("../") else stem.lstrip("/")
        rel_path = pathlib.Path(rel)
        suffixes = (".dx11.dds.dvpl", ".dds.dvpl", ".dx11.pvr.dvpl", ".pvr.dvpl")
        out = []
        for root in self.roots:
            base = root / rel_path.parent
            for suf in suffixes:
                p = base / (rel_path.name + suf)
                if p.exists():
                    out.append(p)
        return out

    def get(self, tex_path: str) -> tuple[Image.Image | None, bool]:
        """返回 (图像|None, has_alpha)。解码失败时 (None, False)。"""
        if tex_path in self._cache:
            return self._cache[tex_path]
        img, has_alpha = None, False
        for cand in self._candidates(tex_path):
            try:
                d = decode_dvpl(cand.read_bytes())
            except Exception:
                continue
            is_dds = d[:4] == b"DDS "
            img = decode_dds(d) if is_dds else decode_pvr3(d)
            if img is not None:
                alpha = img.getchannel("A")
                has_alpha = alpha.getextrema()[0] < 250
                self.from_dds[tex_path] = is_dds
                break
        self._cache[tex_path] = (img, has_alpha)
        if img is not None:
            small = img.convert("RGB").resize((1, 1))
            self.avg_color[tex_path] = tuple(v / 255 for v in small.getpixel((0, 0)))
        return self._cache[tex_path]


# ---------------------------------------------------------------------------
# GLB 组装
# ---------------------------------------------------------------------------


class GlbBuilder:
    """手写 GLB2 容器（与旧版一致：单 buffer + JPEG/PNG 内嵌贴图）。"""

    def __init__(self):
        self.buffer = bytearray()
        self.buffer_views: list[dict] = []
        self.accessors: list[dict] = []
        self.meshes: list[dict] = []
        self.materials: list[dict] = []
        self.images: list[dict] = []
        self.textures: list[dict] = []
        self.nodes: list[dict] = []
        self._tex_by_key: dict = {}
        self.total_tris = 0

    def add_view(self, payload: bytes) -> int:
        while len(self.buffer) % 4:
            self.buffer.append(0)
        offset = len(self.buffer)
        self.buffer.extend(payload)
        self.buffer_views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(payload)})
        return len(self.buffer_views) - 1

    def add_texture(self, key, jpeg_or_png: bytes, mime: str) -> int:
        if key in self._tex_by_key:
            return self._tex_by_key[key]
        view = self.add_view(jpeg_or_png)
        self.images.append({"bufferView": view, "mimeType": mime})
        self.textures.append({"source": len(self.images) - 1})
        self._tex_by_key[key] = len(self.images) - 1
        return self._tex_by_key[key]

    def add_shared_mesh(self, key, positions, indices, uvs, normals, material_index) -> int | None:
        """共享几何（按 datasource 去重）；key=datasource。"""
        pos_view = self.add_view(struct.pack(f"<{len(positions) * 3}f", *[v for p in positions for v in p]))
        mins = [min(p[i] for p in positions) for i in range(3)]
        maxs = [max(p[i] for p in positions) for i in range(3)]
        self.accessors.append({"bufferView": pos_view, "componentType": 5126, "count": len(positions),
                               "type": "VEC3", "min": mins, "max": maxs})
        attrs = {"POSITION": len(self.accessors) - 1}
        if normals is not None:
            nrm_view = self.add_view(struct.pack(f"<{len(normals) * 3}f", *[v for n in normals for v in n]))
            self.accessors.append({"bufferView": nrm_view, "componentType": 5126, "count": len(normals),
                                   "type": "VEC3"})
            attrs["NORMAL"] = len(self.accessors) - 1
        if uvs is not None:
            uv_view = self.add_view(struct.pack(f"<{len(uvs) * 2}f", *[v for uv in uvs for v in uv]))
            self.accessors.append({"bufferView": uv_view, "componentType": 5126, "count": len(uvs),
                                   "type": "VEC2",
                                   "min": [min(p[0] for p in uvs), min(p[1] for p in uvs)],
                                   "max": [max(p[0] for p in uvs), max(p[1] for p in uvs)]})
            attrs["TEXCOORD_0"] = len(self.accessors) - 1
        idx_view = self.add_view(struct.pack(f"<{len(indices)}I", *indices))
        self.accessors.append({"bufferView": idx_view, "componentType": 5125,
                               "count": len(indices), "type": "SCALAR"})
        self.meshes.append({"primitives": [{"attributes": attrs,
                                            "indices": len(self.accessors) - 1,
                                            "material": material_index,
                                            "mode": 4}]})
        self.total_tris += len(indices) // 3
        return len(self.meshes) - 1

    def add_node(self, mesh_index: int, transform: dict, name: str | None) -> None:
        self.nodes.append({
            "mesh": mesh_index,
            "translation": transform["translation"],
            "rotation": transform["rotation"],
            "scale": transform["scale"],
            "name": name or None,
        })

    def finish(self, generator: str) -> bytes:
        gltf = {
            "asset": {"version": "2.0", "generator": generator},
            "scene": 0,
            "scenes": [{"nodes": list(range(len(self.nodes)))}],
            "nodes": self.nodes,
            "meshes": self.meshes,
            "materials": self.materials,
            "textures": self.textures,
            "images": self.images,
            "samplers": [{"wrapS": 10497, "wrapT": 10497, "magFilter": 9729, "minFilter": 9987}],
            "accessors": self.accessors,
            "bufferViews": self.buffer_views,
            "buffers": [{"byteLength": len(self.buffer)}],
        }
        json_chunk = json.dumps(gltf, separators=(",", ":")).encode()
        while len(json_chunk) % 4:
            json_chunk += b" "
        bin_chunk = bytes(self.buffer)
        while len(bin_chunk) % 4:
            bin_chunk += b"\x00"
        total = 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)
        return (struct.pack("<III", 0x46546C67, 2, total)
                + struct.pack("<II", len(json_chunk), 0x4E4F534A) + json_chunk
                + struct.pack("<II", len(bin_chunk), 0x004E4942) + bin_chunk)


# ---------------------------------------------------------------------------
# 导出主流程
# ---------------------------------------------------------------------------


def find_member(directory: pathlib.Path, space: str, suffix: str) -> pathlib.Path | None:
    exact = directory / f"{space}{suffix}"
    if exact.exists():
        return exact
    for p in sorted(directory.glob(f"*{suffix}")):
        return p
    return None


def load_payload(path: pathlib.Path) -> bytes:
    raw = path.read_bytes()
    return decode_dvpl(raw) if path.name.lower().endswith(".dvpl") else raw


def export_map(game_data: pathlib.Path, entry: MapEntry, output_dir: pathlib.Path) -> dict:
    space = entry.space
    directory = game_data / "3d" / "Maps" / space
    sc2_path = find_member(directory, space, ".sc2.dvpl") or find_member(directory, space, ".sc2")
    if sc2_path is None:
        raise FileNotFoundError(f"{space}: 未找到场景文件（{directory}）")
    scg_ext = ".scg.dvpl" if sc2_path.name.lower().endswith(".dvpl") else ".scg"
    scg_path = directory / (sc2_path.stem.replace(".sc2", "") + scg_ext)
    if not scg_path.exists():
        raise FileNotFoundError(f"{space}: 未找到伴随 SCG（{scg_path}）")

    sc2_raw = load_payload(sc2_path)
    scene = read_sc2(sc2_raw)
    scg = read_scg(load_payload(scg_path))
    groups_by_id = {}
    for g in scg.get("polygonGroups", []):
        if isinstance(g, dict):
            raw = g.get("#id")
            if isinstance(raw, dict) and isinstance(raw.get("$bytes"), str):
                try:
                    groups_by_id[struct.unpack("<Q", bytes.fromhex(raw["$bytes"]))[0]] = g
                except ValueError:
                    pass
    materials = MaterialLibrary(scene)
    renderables = collect_renderables(scene)
    instances = renderables["instances"]
    if not instances:
        raise RuntimeError(f"{space}: 无可见网格实例")

    output_dir.mkdir(parents=True, exist_ok=True)
    # `.tex` 相对路径解析根：地图目录（landscape/... 等）与 3d/Maps 根
    # （`../00_global_content/...` 去掉 ../ 后即相对此根）
    textures = TextureStore(directory, [directory.parent])
    glb = GlbBuilder()

    # ---- 几何按 datasource 去重（客户端同型物体共享 PolygonGroup）、材质按
    # 解析后的 albedo 去重（实例级 NMaterial 只是挂同一贴图树的空壳）----
    mesh_by_ds: dict[int, int] = {}
    alpha_bake_cache: dict[tuple, Image.Image] = {}
    material_index_by_albedo: dict[tuple, int] = {}
    stats = {"decode_fail": 0, "no_group": 0, "no_uv": 0, "uv1": 0, "no_texture": 0,
             "impostor": 0, "flatcard": 0, "tree_lod_batch": 0,
             "lod_batch_dropped": renderables.get("lod_batches_dropped", 0)}

    # SpeedTree 实体的批次按 rbN.lodIndex 分 LOD 组（客户端按距离切组渲染）：
    # 同实体只保留"总顶点量最大"的组——lod0 通常最高精度（fir 完整组），但
    # _low 远景变体实体的卡片组在 lod1（lod0 是平板），按几何量择优统一处理。
    # 否则多组同时导出叠加成重影平面。
    lod_group_verts: dict[tuple, dict[int, int]] = {}
    for _n, _t, ds, mid, epath, cls, lod, _sh in instances:
        if cls != "SpeedTreeObject":
            continue
        g = groups_by_id.get(ds)
        if g is None:
            continue
        per = lod_group_verts.setdefault(epath, {})
        per[lod] = per.get(lod, 0) + (g.get("vertexCount") or 0)
    best_lod = {epath: max(per, key=per.get) if per else None
                for epath, per in lod_group_verts.items()}
    drop_lod: set[tuple] = set()
    for _n, _t, ds, mid, epath, cls, lod, _sh in instances:
        if cls == "SpeedTreeObject" and best_lod.get(epath) is not None and lod != best_lod[epath]:
            drop_lod.add((epath, lod))

    for name, transform, datasource, material_id, _path, cls, lod, sh_l0 in instances:
        # SpeedTree 远景 billboard 交叉板：客户端由 SpeedTree 运行时按距离切换 LOD，
        # 静态场景里叶片卡片几何（同实体其他 batch）已完整呈现树形；这些
        # *planes*/*_bb_* 贴图的 batch 若一并导出会变成贯穿树冠的十字大板
        if cls == "SpeedTreeObject":
            if (_path, lod) in drop_lod:
                stats["tree_lod_batch"] += 1
                continue
            desc = materials.resolve(material_id)
            alb = (desc.get("textures") or {}).get("albedo") or ""
            if IMPOSTOR_TEX_RE.search(alb.rsplit("/", 1)[-1]):
                stats["impostor"] += 1
                continue

        group = groups_by_id.get(datasource)
        if group is None:
            stats["no_group"] += 1
            continue
        try:
            positions = decode_polygon_positions(group)
            raw_indices = decode_polygon_indices(group)
        except Exception:
            stats["decode_fail"] += 1
            continue
        indices = group_triangles(group, raw_indices)
        if not indices or len(indices) < 3:
            stats["decode_fail"] += 1
            continue
        # SpeedTree 的远景 LOD 平贴卡片（z 向无厚度 + _low* LOD 贴图，如
        # a_bush1_low1-4/bush02_low1-2）：运行时按距离替换，静态导出会与 3D
        # 几何叠成毛团。仅当"平贴 且 贴图为 _low LOD 变体"时跳过——真水平
        # 叶簇（fir_leaves_2 顶盖等）虽平贴但非 LOD，必须保留
        if cls == "SpeedTreeObject":
            zs = [p[2] for p in positions]
            if max(zs) - min(zs) < 0.4:
                desc = materials.resolve(material_id)
                alb = (desc.get("textures") or {}).get("albedo") or ""
                if LOD_CARD_TEX_RE.search(alb.rsplit("/", 1)[-1]):
                    stats["flatcard"] += 1
                    continue
        decoded = decode_group_uvs(group)
        if decoded is None:
            uvs = uvs1 = None
            stats["no_uv"] += 1
        else:
            uvs, uvs1, channel = decoded
            if channel == 4:
                stats["uv1"] += 1

        mat_desc = materials.resolve(material_id)
        albedo_path = mat_desc["textures"].get("albedo")
        if albedo_path and uvs is not None:
            img, has_alpha = textures.get(albedo_path)
        else:
            img, has_alpha = None, False
            if albedo_path is None:
                stats["no_texture"] += 1
        # UV1 覆盖烘焙（客户端 materials-fp.sl）：
        # - decal 槽（河道蓝瓷砖等）：RGB ×= decal(UV1) × flatColor × 2——
        #   可见纹理在 decal 里，不烘焙就是白色条带
        # - alphamask 槽（瀑布/波纹/烟雾效果层）：A ×= mask(UV1)——镂空+软透明
        # - FLATCOLOR：染色（瀑布水 flatColor 1.4+）
        # - 动画层（TEXTURE0_ANIMATION_SHIFT）用半透明混合（客户端 Translucent）
        mask_path = mat_desc["textures"].get("alphamask")
        # Water 着色器（海/河水面）的 decal 槽语义不同（water-fp.sl 深度染色），
        # 不做 MATERIAL_DECAL 烘焙；水面按客户端语义半透明渲染
        is_water = "water" in (mat_desc.get("fxName") or "").lower()
        decal_path = None if is_water else mat_desc["textures"].get("decal")
        flat_rgb = (1.0, 1.0, 1.0)
        if "flatColor" in (mat_desc.get("properties") or {}):
            flat_rgb = tuple(round(v, 4) for v in
                             _prop_floats(mat_desc, "flatColor", (1, 1, 1, 1))[:3])
        anim_layer = bool((mat_desc.get("flags") or {}).get("TEXTURE0_ANIMATION_SHIFT"))
        needs_bake = (decal_path or mask_path) and uvs1 is not None and img is not None
        if needs_bake and (flat_rgb != (1.0, 1.0, 1.0) or anim_layer or decal_path):
            bake_key = (albedo_path, decal_path, mask_path, flat_rgb)
            if bake_key not in alpha_bake_cache:
                base_img, _ = textures.get(albedo_path)
                decal_img = textures.get(decal_path)[0] if decal_path else None
                mask_img = textures.get(mask_path)[0] if mask_path else None
                if base_img is not None:
                    mult = 2.0 if decal_path else 1.0   # ×2 仅 MATERIAL_DECAL 分支
                    alpha_bake_cache[bake_key] = bake_uv1_overlays(
                        base_img, decal_img, mask_img, flat_rgb, mult,
                        uvs, uvs1, indices)
                    stats["uv1_baked"] = stats.get("uv1_baked", 0) + 1
            baked = alpha_bake_cache.get(bake_key)
            if baked is not None:
                img = baked
                if mask_path:
                    has_alpha = True
        # SpeedTree 材质（speedtree-materials-fp.sl）：color = albedo × SH(L0)
        # × flatColor——无场景光照，alpha discard 0.5。标记 ST| + SH 染色，
        # 前端据此用不受光材质（我们此前的 Lambert+太阳让随机卡片亮度
        # 随朝向乱变，与客户端的均匀叶色完全不符）
        is_st = cls == "SpeedTreeObject" and sh_l0 is not None
        st_tint = min(sh_l0, 2.0) if is_st else None
        mat_key = (albedo_path, decal_path, mask_path, flat_rgb, has_alpha,
                   bool(img is not None), anim_layer and mask_path is not None,
                   is_water, st_tint)
        if mat_key not in material_index_by_albedo:
            material_index_by_albedo[mat_key] = _build_material(
                glb, textures, albedo_path, mat_desc, img, has_alpha,
                blend=(anim_layer and mask_path is not None) or is_water,
                opacity=0.7 if is_water else None,
                st_tint=st_tint)
        material_index = material_index_by_albedo[mat_key]

        # 网格按 (datasource, 材质) 去重：同型物体共享几何，但不同材质的
        # 共享几何（如 seabottom 海床/水面同 16 顶点四边形）必须各自建网格，
        # 否则先到的材质会套给全部实例（水面被渲染成海床）
        mesh_key = (datasource, material_index)
        if mesh_key in mesh_by_ds:
            glb.add_node(mesh_by_ds[mesh_key], transform, name)
            continue

        # SpeedTree 叶片卡致密化（大卡 → 子卡网格 + 随机图集叶簇块）：
        # 客户端近景的加密叶簇几何不在盘上（SCG 已含全部组，无更高精度），
        # 这里按 SpeedTree 的卡片+叶簇图集方式重建密度。仅对带 alpha 的
        # 叶簇材质批处理；子卡双线性覆盖原卡区域，小卡片原样保留——直接
        # 替换本批几何（不与原卡叠加）。
        if cls == "SpeedTreeObject" and has_alpha and uvs is not None:
            d_pos, d_uv, d_idx = densify_speedtree_cards(
                positions, uvs, indices, seed=datasource & 0xFFFF)
            if len(d_idx) > len(indices):
                positions, uvs, indices = d_pos, d_uv, d_idx
                stats["densified"] = stats.get("densified", 0) + 1

        mesh_index = glb.add_shared_mesh(datasource, positions, indices, uvs,
                                         compute_normals(positions, indices), material_index)
        if mesh_index is None:
            continue
        mesh_by_ds[mesh_key] = mesh_index
        glb.add_node(mesh_index, transform, name)

    # ---- 草丛模板（客户端内嵌 customGeometry；实例铺设由前端按密度位图完成）----
    grass_info = renderables["grass"]
    density_written = False
    if grass_info:
        template = grass_info.get("template")
        if template and template["indices"]:
            # 客户端草材质（grass-fp.sl，vro.isLit=false 不受光）：
            # 可见色 = albedo × lightmap × baseColorMultiplier(默认 2.0)。
            # albedo = 草目录中非 lightmap 的贴图（如 0_grass_test.tex）；
            # 两张均为 DDS 源时按行序规则翻回 authored 方向再相乘烘焙。
            grass_mat = {"name": "grass_template",
                         "pbrMetallicRoughness": {"metallicFactor": 0.0,
                                                  "roughnessFactor": 1.0},
                         "doubleSided": True}
            lm_path = grass_info.get("lightmap")
            alb_img = None
            alb_tex_path = None
            if lm_path:
                lm_dir = pathlib.Path(lm_path).parent
                lm_stem = pathlib.Path(lm_path).stem
                # albedo = 草目录中除 lightmap 外的贴图（如 0_grass_test.tex）
                for member in sorted((directory / lm_dir).iterdir()):
                    name = member.name
                    for ext in (".dx11.dds.dvpl", ".dds.dvpl", ".dx11.pvr.dvpl", ".pvr.dvpl"):
                        if name.endswith(ext) and name[: -len(ext)] != lm_stem:
                            alb_tex_path = f"{lm_dir.as_posix()}/{name[:-len(ext)]}.tex"
                            alb_img, _ = textures.get(alb_tex_path)
                            break
                    if alb_img is not None:
                        break
            # vegetationColorMap（= vro.lightmap，如 Im.tex，grass-vp.sl）：
            # RGB = 按世界位置给草染色（前端逐实例 setColorAt），A = 密度
            # （densityScale=vegetationColorSample.a，比 128² flippedDensityMap
            # 精度高一个量级）。材质贴图只乘 baseColorMultiplier，不再乘 Im。
            lm_img = textures.get(lm_path)[0] if lm_path else None
            if alb_img is not None:
                mult = grass_info.get("color_mult", 2.0)
                canvas = np.asarray(alb_img.convert("RGBA"), np.float32) / 255.0
                canvas[..., :3] = np.clip(canvas[..., :3] * mult, 0, 1)
                baked = Image.fromarray((np.clip(canvas, 0, 1) * 255).astype(np.uint8), "RGBA")
                # DDS 源：翻回 authored 方向（glTF v=0 ↔ 首行）
                if textures.from_dds.get(alb_tex_path):
                    baked = baked.transpose(Image.FLIP_TOP_BOTTOM)
                buf = io.BytesIO()
                baked.save(buf, "PNG")
                tex_idx = glb.add_texture(("grass", space), buf.getvalue(), "image/png")
                grass_mat["pbrMetallicRoughness"]["baseColorTexture"] = {"index": tex_idx}
                grass_mat["alphaMode"] = "MASK"
                grass_mat["alphaCutoff"] = 0.33
            mat_index = len(glb.materials)
            glb.materials.append(grass_mat)
            # 全部变体逐个导出（grass_clump_0..N）：客户端按变体轮换密集铺设，
            # 前端实例化时轮换取用；节点名前缀 grass_clump_ 供前端识别后隐藏
            for vi, tpl in enumerate(grass_info.get("templates") or [template]):
                mesh_index = glb.add_shared_mesh(f"grass_template_{vi}", tpl["positions"],
                                                 tpl["indices"],
                                                 tpl["uvs"] or None,
                                                 compute_normals(tpl["positions"],
                                                                 tpl["indices"]),
                                                 mat_index)
                glb.nodes.append({"mesh": mesh_index, "translation": [0, 0, 0],
                                  "rotation": [0, 0, 0, 1], "scale": [1, 1, 1],
                                  "name": f"grass_clump_{vi}"})
        density = grass_info.get("density")
        # 密度与染色优先取 vegetationColorMap（vro.lightmap，如 Im.tex）：
        # grass-vp.sl 里 densityScale=其 alpha、vegetationColor=其 rgb（按世界位置）。
        # 采样坐标链（VP：uv=0.5-pivot/worldSize，uvColor=(1-u,v)）等价于
        # "图像行0=南、列0=西"，与高度场契约一致，无需再翻转。密度网格取 512²
        # （1.17m/格，较旧 128² 密度图精细 4 倍/面积 16 倍）；染色图另存 webp。
        if lm_img is not None:
            GSIZE = 512
            lm_full = np.asarray(lm_img.convert("RGBA"), np.float32) / 255.0
            # 1024→512 2x2 块均值；行序：解码图行0=南（VP 采样链推得）
            h = w = lm_full.shape[0]
            f = h // GSIZE
            if f >= 1 and h == w:
                blk = lm_full.reshape(GSIZE, f, GSIZE, f, 4).mean((1, 3))
                dens = np.round(blk[..., 3] * 255).astype(np.uint8)
                (output_dir / f"{space}.grass.bin").write_bytes(dens.tobytes())
                tint = Image.fromarray((np.clip(blk[..., :3], 0, 1) * 255).astype(np.uint8), "RGB")
                tint.save(output_dir / f"{space}.grasstint.webp", "WEBP", quality=85)
                density_written = True
        if not density_written and density is not None:
            # 回退：flippedDensityMap（存储行0=北，flipud 后行0=南）
            (output_dir / f"{space}.grass.bin").write_bytes(
                np.flipud(density).copy().tobytes())
            density_written = True

    # ---- GLB + sidecar + 地面贴图 ----
    (output_dir / f"{space}.glb").write_bytes(
        glb.finish("wotb-agent export_map_glb (client-aligned)"))

    landscape = renderables["landscape"] or {}
    land_mat = materials.resolve(landscape.get("matname"))
    meta = {
        "mapId": entry.map_id,
        "key": entry.key,
        "display": entry.display,
        "space": space,
        "sc2": entry.local_name,
        "worldBounds": landscape.get("worldBounds"),
        "heightmap": landscape.get("heightmap"),
        "instances": len(glb.nodes),
        "meshes": len(glb.meshes),
        "materials": len(glb.materials),
        "triangles": glb.total_tris,
        "textures": len(glb.images),
        "warnings": {k: v for k, v in stats.items() if v},
    }
    ground = None
    color_tex = land_mat.get("textures", {}).get("colorTexture")
    if color_tex:
        tile_tex = land_mat.get("textures", {}).get("tileTexture0")
        tiling = _prop_floats(land_mat, "textureTiling", default=(50.0, 50.0))
        ground = export_ground(game_data, space, land_mat, directory, output_dir)
        meta["ground"] = {"source": color_tex, "tile": tile_tex,
                          "tiling": tiling[0], "size": ground["size"]}
    (output_dir / f"{space}.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    return {"meta": meta, "bytes": (output_dir / f"{space}.glb").stat().st_size,
            "density": density_written}


def _prop_floats(mat_desc: dict, key: str, default) -> tuple:
    """NMaterial properties 里 float/color 属性的字节解析：
    [type u8][count u8][3B 对齐] 后接 f32 序列，最多取 4 个（不足处用 default 补齐）。"""
    v = mat_desc.get("properties", {}).get(key)
    if not (isinstance(v, dict) and isinstance(v.get("$bytes"), str)):
        return tuple(default)
    b = bytes.fromhex(v["$bytes"])
    n = min(4, (len(b) - 5) // 4) if len(b) >= 9 else 0
    if n <= 0:
        return tuple(default)
    try:
        vals = struct.unpack_from(f"<{n}f", b, 5)
    except struct.error:
        return tuple(default)
    return vals + tuple(default)[n:]




def densify_speedtree_cards(positions, uvs, indices, seed=1, card=(0.26, 0.40),
                            tile=0.25, per_area=0.09, cap=520):
    """SpeedTree 叶簇卡云重建（对齐客户端近景的 billboard-cloud 观感）。

    静态 SCG 的叶片/灌木卡片每张只采样叶簇图集（如 bush02.tex 的 4×4 块）
    的一块，且各卡共面排布——近距离是几层大平面"贴纸"；客户端 SpeedTree
    运行时以体积内大量随机朝向的小叶簇卡渲染（加密几何不在盘上）。
    做法：以原卡面为采样域（面积加权随机取点 + 微法向偏移），生成随机
    朝向、随机图集叶簇块的小卡云替换原几何——轮廓由原卡面保形，观感
    对齐游戏的叶团。返回新 (positions, uvs, indices)。
    """
    if uvs is None or not indices:
        return positions, uvs, indices
    rng = random.Random(seed)

    # 三角形配对成四边形卡片
    tris = [tuple(indices[i:i + 3]) for i in range(0, len(indices), 3)]
    quads = []
    used = [False] * len(tris)
    for i, t1 in enumerate(tris):
        if used[i]:
            continue
        for j in range(i + 1, len(tris)):
            if used[j]:
                continue
            if len(set(t1) & set(tris[j])) == 2:
                quads.append((t1, tris[j]))
                used[i] = used[j] = True
                break
        if not used[i]:
            quads.append((t1, None))
            used[i] = True

    # 面积累积表（世界面积近似：两三角形法和）
    areas = []
    total = 0.0
    for t1, t2 in quads:
        def tarea(t):
            (ax, ay, az), (bx, by, bz), (cx, cy, cz) = (positions[v] for v in t)
            ux, uy, uz = bx - ax, by - ay, bz - az
            vx, vy, vz = cx - ax, cy - ay, cz - az
            return 0.5 * math.sqrt((uy * vz - uz * vy) ** 2 + (uz * vx - ux * vz) ** 2
                                   + (ux * vy - uy * vx) ** 2)
        a = tarea(t1) + (tarea(t2) if t2 else 0.0)
        total += a
        areas.append(total)
    if total <= 0:
        return positions, uvs, indices

    # 平均卡片边长（粗卡组才重建：灌木卡 ~1m；细卡组如 fir 冠层 ~0.25m
    # 本身已足够致密，随机化反而破坏原生的锥形排布）
    mean_edge = 0.0
    for t1, t2 in quads:
        a, b = positions[t1[0]], positions[t1[1]]
        mean_edge += math.dist(a, b)
    mean_edge /= max(1, len(quads))
    if mean_edge < 0.30:
        return positions, uvs, indices

    n_cards = min(cap, max(80, int(total / per_area)))
    out_pos: list = []
    out_uv: list = []
    out_idx: list = []
    tiles = int(1 / tile)
    for _ in range(n_cards):
        # 面积加权随机卡片 + 面上随机点
        r = rng.random() * total
        qi = bisect.bisect_left(areas, r)
        t1, t2 = quads[min(qi, len(quads) - 1)]
        tri = t1 if rng.random() < 0.5 else (t2 or t1)
        w1, w2 = rng.random(), rng.random()
        if w1 + w2 > 1:
            w1, w2 = 1 - w1, 1 - w2
        w0 = 1 - w1 - w2
        px = [positions[tri[0]][k] * w0 + positions[tri[1]][k] * w1
              + positions[tri[2]][k] * w2 for k in range(3)]
        # 沿卡片法向散布（±60% 卡片尺寸）+ 切向微扰：把大卡的采样点撑出
        # 原平面、真正填充体积，避免共面云形成板条
        a, b, c0 = (positions[v] for v in tri)
        nx = (b[1] - a[1]) * (c0[2] - a[2]) - (b[2] - a[2]) * (c0[1] - a[1])
        ny = (b[2] - a[2]) * (c0[0] - a[0]) - (b[0] - a[0]) * (c0[2] - a[2])
        nz = (b[0] - a[0]) * (c0[1] - a[1]) - (b[1] - a[1]) * (c0[0] - a[0])
        nl = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
        s = rng.uniform(*card)
        dn = rng.uniform(-0.6, 0.6) * s / nl
        for k in range(3):
            px[k] += (nx, ny, nz)[k] * dn + rng.uniform(-0.15, 0.15) * s
        # 随机朝向：随机旋转矩阵（正交基）
        ax = rng.uniform(-1, 1); ay = rng.uniform(-1, 1); az = rng.uniform(-1, 1)
        al = math.sqrt(ax * ax + ay * ay + az * az) or 1.0
        ax, ay, az = ax / al, ay / al, az / al
        ang = rng.random() * math.pi * 2
        ca, sa = math.cos(ang), math.sin(ang)
        # Rodrigues 旋转矩阵作用于两个正交基 u/v（法向 = ax,ay,az）
        def rot(v):
            dot = ax * v[0] + ay * v[1] + az * v[2]
            return [v[0] * ca + (ay * v[2] - az * v[1]) * sa + ax * dot * (1 - ca),
                    v[1] * ca + (az * v[0] - ax * v[2]) * sa + ay * dot * (1 - ca),
                    v[2] * ca + (ax * v[1] - ay * v[0]) * sa + az * dot * (1 - ca)]
        # 与法向正交的起始基
        ref = [0.0, 0.0, 1.0] if abs(az) < 0.9 else [1.0, 0.0, 0.0]
        ex = [ay * ref[2] - az * ref[1], az * ref[0] - ax * ref[2], ax * ref[1] - ay * ref[0]]
        el = math.sqrt(sum(c * c for c in ex)) or 1.0
        ex = [c / el for c in ex]
        ey = [az * ex[1] - ay * ex[2], ax * ex[2] - az * ex[0], ay * ex[0] - ax * ex[1]]
        u = rot(ex); v = rot(ey)
        h = s * rng.uniform(0.7, 1.0)
        corners = []
        for (du, dv) in ((-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)):
            corners.append([px[k] + u[k] * du * s + v[k] * dv * h for k in range(3)])
        tu = rng.randrange(tiles) * tile
        tv = rng.randrange(tiles) * tile
        base = len(out_pos)
        out_pos.extend(corners)
        out_uv.extend([(tu, tv), (tu + tile, tv), (tu + tile, tv + tile), (tu, tv + tile)])
        out_idx.extend([base, base + 1, base + 2, base, base + 2, base + 3])
    return out_pos, out_uv, out_idx


def bake_uv1_overlays(base_img: Image.Image, decal_img, mask_img,
                       tint, mult, uvs, uvs1, idx: list) -> Image.Image:
    """UV1 覆盖烘焙（materials-fp.sl 客户端公式）：

    - decal 槽（MATERIAL_DECAL）：RGB ×= decal.rgb(UV1) × flatColor × 2.0
      （DRAW PHASE 的 color *= shadowColor × 2，阴影乘数受光态为 1）
    - alphamask 槽（ALPHA_MASK）：A ×= mask.a(UV1)（效果层镂空/软透明）
    - FLATCOLOR（非 decal 材质）：RGB ×= flatColor（无 ×2）
    按网格 UV0 三角形光栅化，UV1 重心插值采样（decal 平铺 wrap）。
    """
    canvas = base_img.convert("RGBA").copy()
    arr = np.asarray(canvas, np.float32)
    rgb = arr[..., :3].copy() / 255.0
    alpha = arr[..., 3].copy()
    orig_alpha = alpha.copy() / 255.0
    H, W = alpha.shape
    out_a = np.zeros((H, W), np.float32)
    covered = np.zeros((H, W), bool)
    decal = None
    if decal_img is not None:
        decal = np.asarray(decal_img.convert("RGB"), np.float32) / 255.0
    mask = None
    if mask_img is not None:
        mask = np.asarray(mask_img.convert("RGBA"), np.float32)[..., 3] / 255.0
    tint_arr = np.asarray(tint[:3], np.float32)

    for t in range(0, len(idx) - 2, 3):
        i0, i1, i2 = idx[t], idx[t + 1], idx[t + 2]
        xs = [uvs[i][0] * W for i in (i0, i1, i2)]
        ys = [uvs[i][1] * H for i in (i0, i1, i2)]
        xmin = max(0, int(min(xs))); xmax = min(W - 1, int(math.ceil(max(xs))))
        ymin = max(0, int(min(ys))); ymax = min(H - 1, int(math.ceil(max(ys))))
        if xmin > xmax or ymin > ymax:
            continue
        d = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0])
        if abs(d) < 1e-12:
            continue
        gx, gy = np.meshgrid(np.arange(xmin, xmax + 1) + 0.5,
                             np.arange(ymin, ymax + 1) + 0.5)
        w0 = ((xs[1] - gx) * (ys[2] - gy) - (xs[2] - gx) * (ys[1] - gy)) / d
        w1 = ((xs[2] - gx) * (ys[0] - gy) - (xs[0] - gx) * (ys[2] - gy)) / d
        w2 = 1 - w0 - w1
        m = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not m.any():
            continue
        u1 = w0 * uvs1[i0][0] + w1 * uvs1[i1][0] + w2 * uvs1[i2][0]
        v1 = w0 * uvs1[i0][1] + w1 * uvs1[i1][1] + w2 * uvs1[i2][1]
        if decal is not None:
            DH, DW = decal.shape[:2]
            di = (v1 * DH).astype(np.int64) % DH
            dj = (u1 * DW).astype(np.int64) % DW
            factor = decal[di, dj] * tint_arr * mult
            region = rgb[ymin:ymax + 1, xmin:xmax + 1]
            region[m] = np.clip(region[m] * factor[m], 0, 1)
        if mask is not None:
            MH, MW = mask.shape
            mi = (v1 * MH).astype(np.int64) % MH
            mj = (u1 * MW).astype(np.int64) % MW
            vals = mask[mi, mj]
            region_a = out_a[ymin:ymax + 1, xmin:xmax + 1]
            reg_c = covered[ymin:ymax + 1, xmin:xmax + 1]
            region_a[m] = np.maximum(region_a[m], vals[m])
            reg_c |= m

    if decal is None and not np.allclose(tint_arr, 1.0):
        # 非 decal 的 FLATCOLOR：整图染色（无逐像素变化）
        rgb *= tint_arr
    if mask is not None:
        out_a[covered] *= orig_alpha[covered]
        alpha = (np.clip(out_a, 0, 1) * 255)
    arr[..., :3] = np.clip(rgb, 0, 1) * 255.0
    arr[..., 3] = alpha
    return Image.fromarray(arr.astype(np.uint8), "RGBA")


def _build_material(glb: GlbBuilder, textures: TextureStore, albedo_path: str | None,
                    mat_desc: dict, img: Image.Image | None, has_alpha: bool,
                    blend: bool = False, opacity: float | None = None,
                    st_tint: float | None = None) -> int:
    """albedo 贴图（含透明）→ GLB 材质；无贴图时用贴图均值色兜底。

    blend=True（TEXTURE0_ANIMATION_SHIFT 效果层：瀑布/波纹/烟雾）：客户端在
    Translucent 层做 alpha 混合，用 BLEND 模式近似；其余透明材质（树叶卡片）
    为 alpha test，用 MASK。
    """
    base_name = (mat_desc.get("materialName") or "mat")[:60]
    base = {"name": ("ST|" + base_name) if st_tint is not None else base_name,
            "pbrMetallicRoughness": {"metallicFactor": 0.0, "roughnessFactor": 1.0},
            "doubleSided": True}
    if st_tint is not None:
        base["pbrMetallicRoughness"]["baseColorFactor"] = [st_tint, st_tint, st_tint, 1.0]
    if img is not None:
        # DDS 源贴图翻回 authored 方向（row0=top）再嵌入——glTF v=0 ↔ 图像首行，
        # 与客户端 D3D 采样约定对齐；PVR 源解码即对齐，不翻
        embed = img.transpose(Image.FLIP_TOP_BOTTOM) if textures.from_dds.get(albedo_path) else img
        buf = io.BytesIO()
        if has_alpha:
            embed.save(buf, "PNG")
            tex_idx = glb.add_texture(("png", albedo_path), buf.getvalue(), "image/png")
        else:
            embed.convert("RGB").save(buf, "JPEG", quality=85)
            tex_idx = glb.add_texture(("jpg", albedo_path), buf.getvalue(), "image/jpeg")
        base["pbrMetallicRoughness"]["baseColorTexture"] = {"index": tex_idx}
        if opacity is not None:
            base["alphaMode"] = "BLEND"
            base["pbrMetallicRoughness"]["baseColorFactor"] = [1.0, 1.0, 1.0, opacity]
        elif has_alpha and blend:
            base["alphaMode"] = "BLEND"
        elif has_alpha:
            # alpha cutout：SpeedTree 材质（ST|）按客户端 discard 0.5，其余 0.33
            base["alphaMode"] = "MASK"
            base["alphaCutoff"] = 0.5 if st_tint is not None else 0.33
    else:
        r, g, b = textures.avg_color.get(albedo_path or "", (0.62, 0.60, 0.55)) or (0.62, 0.60, 0.55)
        base["pbrMetallicRoughness"]["baseColorFactor"] = [r, g, b, 1.0]
    glb.materials.append(base)
    return len(glb.materials) - 1


def _decode_landscape_tex(textures: TextureStore, tex_path: str) -> Image.Image | None:
    """按贴图槽路径解码（colormap/tilemask/tile 等，RGBA）。"""
    img, _ = textures.get(tex_path)
    return img


def decode_tiletx_planes_from_slot(tile_tex: str, map_dir: pathlib.Path):
    """TileTex 槽 -> [4 张灰度细节 ndarray]；文件缺失/结构不符返回 None。"""
    stem = tile_tex[:-4] if tile_tex.lower().endswith(".tex") else tile_tex
    rel = stem[3:] if stem.startswith("../") else stem.lstrip("/")
    base = map_dir / pathlib.Path(rel).parent / pathlib.Path(rel).name
    for suf in (".dx11.pvr.dvpl", ".pvr.dvpl", ".dx11.dds.dvpl", ".dds.dvpl"):
        cand = base.with_name(base.name + suf)
        if cand.exists():
            d = decode_dvpl(cand.read_bytes())
            return decode_tiletx_planes(d)
    return None


def _srgb_to_linear(arr):
    """sRGB -> 线性（客户端 shader 的硬件解码行为）。"""
    c = np.clip(np.asarray(arr, dtype=np.float32), 0.0, 1.0)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _linear_to_srgb(arr):
    """线性 -> sRGB（客户端输出编码）。"""
    c = np.clip(np.asarray(arr, dtype=np.float32), 0.0, None)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def _resize_channels(img: Image.Image, size: tuple[int, int]) -> np.ndarray:
    """RGBA 图逐通道重采样为 float32 HxWx4（0..1）。

    PIL 对 RGBA 图整体 resize 会把透明区 RGB 与可见区混算（实测 mask R 通道
    均值 0.585→0.168），必须逐通道缩放——与客户端 GPU 各通道独立采样一致。
    """
    return np.stack([np.asarray(img.getchannel(i).resize(size, Image.BILINEAR), dtype=np.float32)
                     for i in range(4)], axis=-1) / 255.0


def bake_ground(colormap: Image.Image, planes, mask_img, hmap_planes,
                cfg: dict) -> Image.Image:
    """按客户端 Landscape/tilemask-fp.sl 非 PBR 路径逐像素烘焙地表。

    着色器（Data/Materials/Shaders/Landscape/tilemask-fp.sl，按材质 flags 分支）：
        colorMapAlbedo *= globalFlatColor * 2            # 仅 FLATCOLOR/GLOBAL_TINT
        alpha 调整 (brightness,contrast,gamma)            # 仅 GLOBAL_TINT 内 SEPARATE_LIGHTMAP_CHANNEL
        shadowColor = colorMapAlbedo * colorMapFetch.a    # SEPARATE_LIGHTMAP_CHANNEL；
                                                          # SHADOW_RECEIVER 全光照态乘数为 1
        非 HeightBlend: out = (Σ_k tile.ch_k * mask.ch_k * tileColor_k) * shadowColor * 2
        HeightBlend:    mask2 = sat(tilemaskWeight*(mask*2-1) + hMap*scaleColor + offsetColor)
                        out = HeightBlend(tile.ch_k*tileColor_k, mask2) * shadowColor * 2
                        （HeightBlend: b = max(mask2 - (max(mask2)-softness), 0.001) 归一加权）
        SCALED_TILES:   每通道按各自 tileScale_k 平铺采样
    权重不做归一/整形、阴影不设下限——均为客户端原样（烘焙不做任何提亮）。
    输出做垂直翻转：贴图 t=0 对应世界 +y（北），WebP 契约上边=+z（北）。
    """
    # 4096²：清晰度主要来自 tile 细节纹理的平铺频率（colormap 本身低频，
    # 双线性放大不损失信息）——输出线性分辨率翻倍，tile 采样密度同步翻倍
    h = w = 4096
    cm = _resize_channels(colormap.convert("RGBA"), (w, h))
    albedo = cm[..., :3].copy()
    alpha = cm[..., 3:4].copy()
    if cfg["flatcolor"]:
        albedo *= np.asarray(cfg["flat_color"][:3], dtype=np.float32) * 2.0
        if cfg["separate_lm"]:
            br, ct, gm = cfg["lm_adjust"][:3]
            alpha = np.power(alpha, gm)
            alpha = (alpha - 0.5) * ct + 0.5
            alpha = alpha + br
    shadow = albedo * alpha if cfg["separate_lm"] else albedo

    def channel_fetch_k(planes4, scales, k):
        """tileTexture0/tileHeightTexture 第 k 通道的平铺采样（客户端单次 RGBA
        fetch 取 .r/.g/.b/.a；4 平面容器按"平面 k = 通道 k"展开；SCALED_TILES
        时每通道各自 tileScale_k）。按通道惰性取用控制 4096² 内存峰值。"""
        ph, pw = planes4[k].shape[:2]
        ys = ((np.arange(h) * cfg["tiling"][1] * scales[k]) % ph).astype(np.int64)
        xs = ((np.arange(w) * cfg["tiling"][0] * scales[k]) % pw).astype(np.int64)
        return planes4[k].astype(np.float32)[np.ix_(ys, xs)] / 255.0

    if planes is None or len(planes) != 4:
        planes = [np.full((512, 512), 115, np.uint8)] * 4

    if mask_img is not None:
        mask = _resize_channels(mask_img.convert("RGBA"), (w, h))
    else:
        mask = np.full((h, w, 4), 0.25, dtype=np.float32)

    if cfg["height_blend"] and hmap_planes is not None:
        hch = [channel_fetch_k(hmap_planes, cfg["tile_scale"], k) for k in range(4)]
        hmap = np.stack(hch, axis=-1)
        mask2 = cfg["tilemask_weight"] * (mask * 2.0 - 1.0) \
            + hmap * np.asarray(cfg["hb_scale"][:4], dtype=np.float32) \
            + np.asarray(cfg["hb_offset"][:4], dtype=np.float32)
        np.clip(mask2, 0.0, 1.0, out=mask2)
        start = mask2.max(axis=-1, keepdims=True) - np.asarray(cfg["hb_softness"][:4], dtype=np.float32)
        b = np.maximum(mask2 - start, 0.001)
        denom = b.sum(axis=-1, keepdims=True)
        detail = np.zeros((h, w, 3), dtype=np.float32)
        for k in range(4):
            tint = np.asarray(cfg["tile_colors"][k][:3], dtype=np.float32)
            detail += channel_fetch_k(planes, cfg["tile_scale"], k)[..., None] * tint * b[..., k:k + 1]
        detail /= denom
    else:
        detail = np.zeros((h, w, 3), dtype=np.float32)
        for k in range(4):
            tint = np.asarray(cfg["tile_colors"][k][:3], dtype=np.float32)
            detail += channel_fetch_k(planes, cfg["tile_scale"], k)[..., None] * tint * mask[..., k:k + 1]

    out = detail * shadow * 2.0
    img = Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8), "RGB")
    return img.transpose(Image.FLIP_TOP_BOTTOM)


def landscape_bake_cfg(land_mat: dict) -> dict:
    """从解析后的 Landscape NMaterial 提取 tilemask-fp.sl 所需 flags/属性。"""
    flags = land_mat.get("flags") or {}

    def fprop(key, default):
        return list(_prop_floats(land_mat, key, default))

    return {
        # FLATCOLOR/GLOBAL_TINT（32_faust_night 等）；着色器内 globalFlatColor 缺省 0.5 → ×2 后中性
        "flatcolor": any(flags.get(k) for k in ("FLATCOLOR", "GLOBAL_TINT")),
        "flat_color": fprop("globalFlatColor", (0.5, 0.5, 0.5)),
        "separate_lm": bool(flags.get("LANDSCAPE_SEPARATE_LIGHTMAP_CHANNEL")),
        "lm_adjust": fprop("landscapeLightmapAdjustment", (0.0, 1.0, 1.0)),
        # SCALED_TILES：仅此旗标下客户端才逐通道 tileScale 采样，否则单次 RGBA 取
        "scaled_tiles": bool(flags.get("LANDSCAPE_SCALED_TILES_NON_PBR")),
        "height_blend": bool(flags.get("LANDSCAPE_HEIGHT_BLEND")),
        "tilemask_weight": fprop("tilemaskWeight", (0.15,))[0],
        "hb_scale": fprop("heightMapScaleColor", (1.0, 1.0, 1.0, 1.0)),
        "hb_offset": fprop("heightMapOffsetColor", (0.0, 0.0, 0.0, 0.0)),
        "hb_softness": fprop("heightMapSoftnessColor", (0.15, 0.15, 0.15, 0.15)),
        "tile_scale": [fprop(f"tileScale{i}", (1.0,))[0] for i in range(4)],
        "tile_colors": [fprop(f"tileColor{i}", (1.0, 1.0, 1.0)) for i in range(4)],
        "tiling": fprop("textureTiling", (50.0, 50.0)),
    }


def export_ground(game_data: pathlib.Path, space: str, land_mat: dict,
                  map_dir: pathlib.Path, output_dir: pathlib.Path) -> dict:
    """客户端 Landscape 地表烘焙 → WebP（上=+z/北，与底图契约一致）。"""
    if Image is None or imagecodecs is None:
        raise RuntimeError("需要 pip install pillow imagecodecs")

    def resolve_file(tex_path: str) -> pathlib.Path | None:
        stem = tex_path[:-4] if tex_path.lower().endswith(".tex") else tex_path
        rel = stem[3:] if stem.startswith("../") else stem.lstrip("/")
        base = map_dir / pathlib.Path(rel).parent / pathlib.Path(rel).name
        for suf in (".dx11.dds.dvpl", ".dds.dvpl", ".dx11.pvr.dvpl", ".pvr.dvpl"):
            cand = base.with_name(base.name + suf)
            if cand.exists():
                return cand
        return None

    def decode_opt(tex_path):
        if not tex_path:
            return None
        tf = resolve_file(tex_path)
        if tf is None:
            return None
        td = decode_dvpl(tf.read_bytes())
        return decode_dds(td, max_dim=2048) if td[:4] == b"DDS " else decode_pvr3(td, max_dim=2048)

    tex = land_mat.get("textures", {})
    color_tex = tex.get("colorTexture")
    src = resolve_file(color_tex) if color_tex else None
    if src is None:
        raise FileNotFoundError(f"{space}: colormap 文件缺失（{color_tex}）")
    cfg = landscape_bake_cfg(land_mat)
    cmap = decode_opt(color_tex)

    def tile_channels(tex_path):
        """TileTx/Height 纹理 → 4 通道细节平面。

        客户端把 4 张细节图打包为单张 RGBA 纹理的四个通道（着色器单次 RGBA
        采样取 .r/.g/.b/.a）；少数变体是 DAVA 四平面容器（每平面单通道 4444
        mip 链，普通解码因载荷长度不符而失败），退回专用四平面解码。
        """
        if not tex_path:
            return None
        img = decode_opt(tex_path)
        if img is not None:
            arr = np.asarray(img.convert("RGBA"), dtype=np.uint8)
            return [arr[..., k].copy() for k in range(4)]
        return decode_tiletx_planes_from_slot(tex_path, map_dir)

    planes = tile_channels(tex.get("tileTexture0"))

    # HeightBlend 分支用 tileMaskHeightBlend + tileHeightTexture（着色器同名采样器）
    mask_tex = tex.get("tileMaskHeightBlend") if cfg["height_blend"] else None
    mask_tex = mask_tex or tex.get("tileMask")
    mask_img = decode_opt(mask_tex) if mask_tex else None
    hmap_planes = tile_channels(tex.get("tileHeightTexture")) if cfg["height_blend"] else None

    baked = bake_ground(cmap, planes, mask_img, hmap_planes, cfg)
    out = output_dir / f"{space}.ground.webp"
    baked.save(out, "WEBP", quality=90)

    # ---- 客户端同款分层导出：前端 ShaderMaterial 按 tilemask-fp.sl 实时合成，
    # tile/height 纹理以原生分辨率平铺重复（客户端 texCoordTiled = texCoord ×
    # textureTiling，约 30–120 次重复/全图），清晰度不再受烘焙网格分辨率限制。
    # 行序保持 colormap 原始空间（不翻转）；前端采样 uv = (0.5−X/s, 0.5−Z/s)。
    # tile/height/mask 是四个独立语义通道，必须无损（有损 RGB 会通道串色）。
    layers: dict = {
        "tiling": [round(v, 4) for v in cfg["tiling"]],
        "tile_scale": [round(v, 4) for v in cfg["tile_scale"]],
        "tile_colors": [[round(c, 4) for c in tc[:3]] for tc in cfg["tile_colors"]],
        "flatcolor": bool(cfg["flatcolor"]),
        "flat_color": [round(v, 4) for v in cfg["flat_color"][:3]],
        "separate_lm": bool(cfg["separate_lm"]),
        "lm_adjust": [round(v, 4) for v in cfg["lm_adjust"][:3]],
        "scaled_tiles": bool(cfg["scaled_tiles"]),
        "height_blend": bool(cfg["height_blend"]),
        "tilemask_weight": round(cfg["tilemask_weight"], 4),
        "hb_scale": [round(v, 4) for v in cfg["hb_scale"][:4]],
        "hb_offset": [round(v, 4) for v in cfg["hb_offset"][:4]],
        "hb_softness": [round(v, 4) for v in cfg["hb_softness"][:4]],
        "files": {},
    }

    def save_layer(name: str, img: Image.Image, lossless: bool = True) -> None:
        p = output_dir / f"{space}.ground.{name}.webp"
        if lossless:
            img.save(p, "WEBP", lossless=True)
        else:
            img.save(p, "WEBP", quality=92)
        layers["files"][name] = {"size": list(img.size), "bytes": p.stat().st_size}

    # 注意：所有载荷一律无 alpha（RGB/灰度 webp）——Chrome 把带 alpha 的 webp
    # 解码为预乘 RGB（three.js 原样上传后权重/细节被 alpha 压暗近黑，实测 mask
    # 的 4 通道被 0.043 的 alpha 压成近零 → 地面大片变黑）。第 4 通道拆独立灰度图。
    cm_rgba = cmap.convert("RGBA")
    save_layer("cm", cm_rgba.convert("RGB"), lossless=False)          # colorTexture RGB
    save_layer("lm", cm_rgba.getchannel("A"))                         # colorTexture.a = lightmap
    if planes is not None and len(planes) == 4:
        pl = np.stack(planes, axis=-1).astype(np.uint8)
        save_layer("tile0", Image.fromarray(pl[..., :3], "RGB"))      # tileTexture0 ch0-2
        save_layer("tile1", Image.fromarray(pl[..., 3]))              # tileTexture0 ch3
    if mask_img is not None:
        mk = np.asarray(mask_img.convert("RGBA"), dtype=np.uint8)
        save_layer("mask0", Image.fromarray(mk[..., :3], "RGB"))      # mask ch0-2
        save_layer("mask1", Image.fromarray(mk[..., 3]))              # mask ch3
    if cfg["height_blend"] and hmap_planes is not None and len(hmap_planes) == 4:
        hp = np.stack(hmap_planes, axis=-1).astype(np.uint8)
        save_layer("hmap0", Image.fromarray(hp[..., :3], "RGB"))      # tileHeight ch0-2
        save_layer("hmap1", Image.fromarray(hp[..., 3]))              # tileHeight ch3
    need = 8 if cfg["height_blend"] else 6
    if len(layers["files"]) >= need:
        lp = output_dir / f"{space}.ground.layers.json"
        lp.write_text(json.dumps(layers, ensure_ascii=False), encoding="utf-8")

    return {"size": baked.size, "bytes": out.stat().st_size, "source": src.name,
            "tile": tex.get("tileTexture0"), "mask": mask_tex}


def _export_map_worker(task: dict) -> dict:
    """并行导出的子进程入口：导出单张地图，返回结果摘要（异常转 failure）。"""
    game_data = pathlib.Path(task["game_data"])
    out_dir = pathlib.Path(task["output_dir"])
    e = task["entry"]
    entry = MapEntry(e["map_id"], e["key"], e["local_name"], e["minimap_dir"], e["display"])
    started = time.time()
    try:
        if task["ground_only"]:
            directory = game_data / "3d" / "Maps" / entry.space
            sc2_path = find_member(directory, entry.space, ".sc2.dvpl") or find_member(directory, entry.space, ".sc2")
            scene = read_sc2(load_payload(sc2_path))
            land_mat = MaterialLibrary(scene).resolve(collect_renderables(scene)["landscape"]["matname"])
            ground = export_ground(game_data, entry.space, land_mat, directory, out_dir)
            return {"key": entry.key, "space": entry.space, "map_id": entry.map_id,
                    "ok": True, "sec": round(time.time() - started, 1),
                    "line": f"[ok] {entry.space:<20} 地面 {ground['size'][0]}x{ground['size'][1]} "
                            f"{ground['bytes'] / 1e6:.2f}MB"}
        info = export_map(game_data, entry, out_dir)
        m = info["meta"]
        bound = m.get("worldBounds")
        zmax = f"{bound['max'][2]:.0f}m" if bound else "?"
        return {"key": entry.key, "space": entry.space, "map_id": entry.map_id,
                "ok": True, "sec": round(time.time() - started, 1),
                "line": f"[ok] id={entry.map_id:<3} {entry.key:<18} space={entry.space:<20} "
                        f"实例 {m['instances']:>5} 网格 {m['meshes']:>4} 三角形 {m['triangles']:>8} "
                        f"贴图 {m['textures']:>3} zmax={zmax} {info['bytes'] / 1e6:.1f}MB"
                        + (f" 警告{m['warnings']}" if m["warnings"] else "")}
    except Exception as exc:
        return {"key": entry.key, "space": entry.space, "map_id": entry.map_id,
                "ok": False, "sec": round(time.time() - started, 1),
                "line": f"[fail] id={entry.map_id:<3} {entry.key:<18} {entry.space}: {exc}"}


def _write_status(status_path: pathlib.Path, state: dict) -> None:
    """原子更新进度状态文件（外部可随时读取查询导出是否完成）。"""
    state["updated_at"] = time.strftime("%H:%M:%S")
    tmp = status_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(status_path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--map", action="append",
                        help="只导出指定图（回放 id / 显示名 / maps.yaml 键，可重复）；缺省全部")
    parser.add_argument("--game-data", type=pathlib.Path,
                        default=pathlib.Path("D:/SteamLibrary/steamapps/common/World of Tanks Blitz/Data"))
    parser.add_argument("--output-dir", type=pathlib.Path, default=pathlib.Path("glb_cache/maps"))
    parser.add_argument("--ground-only", action="store_true",
                        help="跳过 GLB，只重新导出地面贴图（+元数据）")
    parser.add_argument("--jobs", type=int, default=4,
                        help="并行导出进程数（缺省 4；每张图相互独立）")
    args = parser.parse_args()

    started = time.time()
    status_path = args.output_dir / "_export_status.json"
    state = {"total": 0, "done": 0, "failed": 0, "finished": False,
             "results": [], "failures": []}

    def put_status() -> None:
        state["elapsed_sec"] = round(time.time() - started, 1)
        _write_status(status_path, state)

    entries = load_registry(args.game_data)
    print(f"注册表：{len(entries)} 张地图（maps.yaml ∩ en.yaml）", flush=True)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    if args.map:
        wanted = []
        for name in args.map:
            e = resolve_entry(entries, name)
            if e is None:
                print(f"[skip] {name}: 注册表无此图", flush=True)
            else:
                wanted.append(e)
    else:
        wanted = entries

    # 按 space 去重（变体地图共享场景）
    seen_space: set[str] = set()
    targets = []
    for e in wanted:
        if e.space not in seen_space:
            seen_space.add(e.space)
            targets.append(e)

    state["total"] = len(targets)
    put_status()
    tasks = [{"game_data": str(args.game_data), "output_dir": str(args.output_dir),
              "entry": {"map_id": e.map_id, "key": e.key, "local_name": e.local_name,
                        "space": e.space, "minimap_dir": e.minimap_dir,
                        "display": e.display},
              "ground_only": bool(args.ground_only)}
             for e in targets]

    def on_result(res: dict) -> None:
        state["done"] += 1
        entry_rec = {"key": res["key"], "space": res["space"],
                     "ok": res["ok"], "sec": res["sec"]}
        if res["ok"]:
            state["results"].append(entry_rec)
        else:
            state["failed"] += 1
            state["failures"].append(res["space"])
            state["results"].append({**entry_rec, "error": res["line"]})
        put_status()
        elapsed = time.time() - started
        remain = elapsed / state["done"] * (state["total"] - state["done"])
        print(f"({state['done']}/{state['total']}，剩余约 {remain:.0f}s) {res['line']}", flush=True)

    jobs = max(1, min(int(args.jobs), len(targets)))
    if jobs > 1:
        print(f"并行导出 {len(targets)} 张图（jobs={jobs}），进度：{status_path}", flush=True)
        with concurrent.futures.ProcessPoolExecutor(max_workers=jobs) as pool:
            for res in pool.map(_export_map_worker, tasks):
                on_result(res)
    else:
        for task in tasks:
            on_result(_export_map_worker(task))

    state["finished"] = True
    put_status()
    if state["failed"]:
        print(f"\n失败 {state['failed']}：{', '.join(state['failures'])}", flush=True)
        return 1
    print(f"\n全部完成：{state['total']} 张，耗时 {time.time() - started:.0f}s", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
