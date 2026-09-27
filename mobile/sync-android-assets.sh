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

# 全量版先拷大资产（模型 + 地图资产 + 地形）
if [ "$1" = "--full" ]; then
  echo "syncing data/cache (models + maps + terrain, ~2GB) ..."
  mkdir -p "$DEST/data/cache"
  cp -r "$ROOT/data/cache/." "$DEST/data/cache/"
fi

# 小资产覆盖同步（data/ 含 cache 底图 webp/地形/封面、web/vendor）
echo "syncing resources/ ..."
cp -r "$RES/." "$DEST/"

echo "assets total: $(du -sh "$DEST" | cut -f1)"
