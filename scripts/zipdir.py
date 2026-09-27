# 把目录打包成 zip（package.ps1 的全量包压缩后端）。
# 为什么不用 PowerShell 的 Compress-Archive：
#   1. PS 5.1 的 Compress-Archive 有 2GB 上限，glb_cache 随游戏更新会突破；
#   2. GLB/图片本身已是压缩格式，逐字节 deflate 九分钟只省约 6% 体积，
#      本脚本对这些扩展名直接 ZIP_STORED 存储，只压缩文本/JSON/EXE，快一个量级；
#   3. 自动 ZIP64，中文文件名按 UTF-8 标记写入（Windows 11 资源管理器与主流解压工具均正常）。
# 用法：python scripts/zipdir.py <源目录> <目标.zip>
import os
import sys
import time
import zipfile

# 已压缩格式：直接存储，避免无效的二次 deflate
STORED_EXTS = {
    ".glb", ".gltf", ".bin",
    ".png", ".jpg", ".jpeg", ".webp", ".ico", ".bmp",
    ".ktx2", ".basis", ".dds", ".ogg", ".mp3", ".wav", ".mp4",
    ".zip", ".7z", ".gz", ".dvpl",
}


def main() -> int:
    if len(sys.argv) != 3:
        print("用法: python zipdir.py <源目录> <目标.zip>", file=sys.stderr)
        return 2
    src, dst = os.path.abspath(sys.argv[1]), sys.argv[2]
    if not os.path.isdir(src):
        print(f"源目录不存在: {src}", file=sys.stderr)
        return 2

    started = time.time()
    count = 0
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as z:
        for root, dirs, files in os.walk(src):
            dirs.sort()
            for name in sorted(files):
                path = os.path.join(root, name)
                arc = os.path.relpath(path, src).replace(os.sep, "/")
                stored = os.path.splitext(name)[1].lower() in STORED_EXTS
                z.write(path, arc, compress_type=zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED)
                count += 1
                if count % 2000 == 0:
                    print(f"  已打包 {count} 个文件...", flush=True)

    size_mb = os.path.getsize(dst) / 1e6
    print(f"完成: {count} 个文件 -> {dst} ({size_mb:.0f} MB, 耗时 {time.time() - started:.0f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
