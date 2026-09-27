#!/usr/bin/env python3
"""准备 Tauri 打包资产树（在 mobile/src-tauri/ 下生成 resources/ 与 resources-manifest.txt）。

  python prepare-assets.py          # 轻量版：data/ + web/vendor + tank_images + 地图底图
  python prepare-assets.py --full   # 追加 resources-glb/（全部坦克 GLB + 地形/场景 GLB，懒读取不解包）

目录形态 = 应用运行根目录（base_dir）布局，因此 tauri 资源路径与 data::app_path 一致。
"""
import os, shutil, sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))  # 仓库根
TAURI = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(TAURI, 'resources')
RES_GLB = os.path.join(TAURI, 'resources-glb')

def copy_tree(src, dst, skip=lambda name: False, only_ext=None):
    n = 0
    for cur, _dirs, files in os.walk(src):
        rel = os.path.relpath(cur, src)
        for f in files:
            if skip(f) or (only_ext and not f.lower().endswith(only_ext)):
                continue
            d = dst if rel == '.' else os.path.join(dst, rel)
            os.makedirs(d, exist_ok=True)
            shutil.copy2(os.path.join(cur, f), os.path.join(d, f))
            n += 1
    return n

def main():
    full = '--full' in sys.argv
    if os.path.isdir(RES):
        shutil.rmtree(RES)
    os.makedirs(RES)

    total = 0
    # data/（排除 sessions 运行时数据）
    total += copy_tree(os.path.join(ROOT, 'data'), os.path.join(RES, 'data'),
                       skip=lambda f: f == 'sessions')
    # web/vendor 前端依赖
    total += copy_tree(os.path.join(ROOT, 'web', 'vendor'), os.path.join(RES, 'web', 'vendor'))
    # 坦克封面图
    total += copy_tree(os.path.join(ROOT, 'tank_images'), os.path.join(RES, 'tank_images'))
    # 示例回放预置为 replays/（移动端 replay_dir 指向私有 replays/，开箱即可 Scan）
    total += copy_tree(os.path.join(ROOT, 'replay_samples'), os.path.join(RES, 'replays'))
    # 地图高清底图（2048² ground.webp，轻量版也有——回放底图必需）
    total += copy_tree(os.path.join(ROOT, 'glb_cache', 'maps'), os.path.join(RES, 'glb_cache', 'maps'),
                       only_ext=('.webp',))

    # 生成解包清单（只含小资产；--full 的 GLB 大资产走懒读取不进清单）
    lines = []
    for cur, _dirs, files in os.walk(RES):
        rel = os.path.relpath(cur, RES)
        for f in sorted(files):
            rel_path = f if rel == '.' else (rel + '/' + f).replace(os.sep, '/')
            lines.append(rel_path)
    with open(os.path.join(TAURI, 'resources-manifest.txt'), 'w', encoding='utf-8', newline='\n') as fh:
        fh.write('\n'.join(sorted(lines)) + '\n')

    print(f'resources/: {total} files')

    if full:
        if os.path.isdir(RES_GLB):
            shutil.rmtree(RES_GLB)
        os.makedirs(RES_GLB)
        n1 = copy_tree(os.path.join(ROOT, 'glb_cache'), os.path.join(RES_GLB, 'glb_cache'),
                       skip=lambda f: f.endswith('.ground.webp'))
        print(f'resources-glb/: {n1} files (lazy-read)')

if __name__ == '__main__':
    main()
