#!/bin/bash
# 同步打包资产到 Android 工程 assets/（tauri android init 之后、build 之前运行）
#   轻量版: bash sync-android-assets.sh
#   全量版: bash sync-android-assets.sh --full     （追加全部坦克 GLB + 地形/场景 GLB）
set -e
cd "$(dirname "$0")"
ROOT=".."                                       # 仓库根（mobile/ 的上一级）
RES="src-tauri/resources"                       # prepare-assets.py 生成的小资产树
DEST="src-tauri/gen/android/app/src/main/assets"

if [ ! -d "$DEST" ]; then
  echo "gen/android 未初始化 —— 先运行: (cd src-tauri && tauri android init)" >&2
  exit 1
fi
mkdir -p "$DEST"

# 全量版先拷 GLB 大资产（模型 + 地形/场景）
if [ "$1" = "--full" ]; then
  echo "syncing glb_cache (models + terrain, ~1.9GB) ..."
  mkdir -p "$DEST/glb_cache/maps"
  cp -r "$ROOT/glb_cache/." "$DEST/glb_cache/"
fi

# 小资产覆盖同步（data/、web/vendor、tank_images、地图底图 webp）
echo "syncing resources/ ..."
cp -r "$RES/." "$DEST/"

echo "assets total: $(du -sh "$DEST" | cut -f1)"
