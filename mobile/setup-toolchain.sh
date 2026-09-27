#!/bin/bash
# Android 构建工具链手动安装：JDK17(清华镜像) + SDK 包直连 dl.google.com 下载解包。
# 依赖：curl / unzip。产物：$LOCALAPPDATA/Android/Sdk + mobile/android-env.sh
set -e
SDK="$LOCALAPPDATA/Android/Sdk"
DL="D:/class/rust/project/mobile/dl"
BASE="https://dl.google.com/android/repository"
mkdir -p "$SDK" "$DL"
cd "$DL"

echo "[1/5] JDK 17 (Tsinghua mirror)..."
if [ ! -d "$DL/jdk17/jdk-17.0.20.1+1" ]; then
  curl -sfL --retry 3 -o jdk17.zip "https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/x64/windows/OpenJDK17U-jdk_x64_windows_hotspot_17.0.20.1_1.zip"
  mkdir -p jdk17 && unzip -q -o jdk17.zip -d jdk17
fi
JDK_DIR=$(ls -d "$DL"/jdk17/jdk-* | head -1)
echo "JDK at: $JDK_DIR"

echo "[2/5] cmdline-tools..."
if [ ! -d "$SDK/cmdline-tools/latest" ]; then
  curl -sfL --retry 3 -o cmdtools.zip "$BASE/commandlinetools-win-9862592_latest.zip"
  mkdir -p "$SDK/cmdline-tools"
  unzip -q -o cmdtools.zip -d "$SDK/cmdline-tools"
  mv "$SDK/cmdline-tools/cmdline-tools" "$SDK/cmdline-tools/latest"
fi

echo "[3/5] platform-tools / platforms / build-tools..."
pkg() { # pkg <url> <unzip-dest-subdir-of-SDK>
  local url="$1" name
  name=$(basename "$url")
  [ -f "$DL/$name" ] || curl -sfL --retry 3 -o "$DL/$name" "$url"
  unzip -q -o "$DL/$name" -d "$SDK/$2"
}
pkg "$BASE/platform-tools_r37.0.1-win.zip" ""
pkg "$BASE/platform-34-ext7_r03.zip" ""
pkg "$BASE/platform-35_r02.zip" ""
pkg "$BASE/build-tools_r34-windows.zip" ""
pkg "$BASE/build-tools_r35_windows.zip" ""
# 归位目录名（zip 内顶层名 → SDK 约定名）
[ -d "$SDK/android-34" ] || mv "$SDK"/platform-34* "$SDK/android-34" 2>/dev/null || true
[ -d "$SDK/android-35" ] || mv "$SDK"/platform-35* "$SDK/android-35" 2>/dev/null || true
[ -d "$SDK/build-tools/34.0.0" ] || { mkdir -p "$SDK/build-tools"; mv "$SDK"/android-14/* "$SDK/build-tools/34.0.0" 2>/dev/null || mv "$SDK"/*build-tools*34* "$SDK/build-tools/34.0.0" 2>/dev/null || true; }
[ -d "$SDK/build-tools/35.0.0" ] || { mkdir -p "$SDK/build-tools"; mv "$SDK"/android-15/* "$SDK/build-tools/35.0.0" 2>/dev/null || mv "$SDK"/*build-tools*35* "$SDK/build-tools/35.0.0" 2>/dev/null || true; }

echo "[4/5] NDK r27d (biggest, ~1GB)..."
if [ ! -d "$SDK/ndk/27.1.12297006" ] && [ ! -d "$SDK/ndk/27.0.12077973" ]; then
  curl -sfL --retry 3 -o ndk.zip "$BASE/android-ndk-r27d-windows.zip"
  mkdir -p "$SDK/ndk"
  unzip -q -o ndk.zip -d "$SDK/ndk"
  mv "$SDK/ndk"/android-ndk-r27d "$SDK/ndk/27.1.12297006"
fi
NDK_DIR=$(ls -d "$SDK"/ndk/*/ | head -1)
echo "NDK at: $NDK_DIR"

echo "[5/5] licenses + env file..."
mkdir -p "$SDK/licenses"
printf '8933bad161af4178b1185d1a37fbf41ea5269c55\nd56f5187479451eabf01fb78af6dfcb131a6481e\n24333f8a63b6825ea9c5514f83c2829b004d1fee' > "$SDK/licenses/android-sdk-license"
printf '84831b9409646a918e30573bab4c9c91346d8abd' > "$SDK/licenses/android-sdk-preview-license"

cat > "D:/class/rust/project/mobile/android-env.sh" <<ENV
export JAVA_HOME="$(cygpath -w "$JDK_DIR")"
export ANDROID_HOME="$(cygpath -w "$SDK")"
export ANDROID_NDK_HOME="$(cygpath -w "${NDK_DIR%/}")"
export NDK_HOME="$(cygpath -w "${NDK_DIR%/}")"
ENV
echo "=== TOOLCHAIN SETUP DONE ==="
cat "D:/class/rust/project/mobile/android-env.sh"
