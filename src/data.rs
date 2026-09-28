// 数据路径层：全部运行时数据统一放项目根 `data/` 目录，经 data_path()/cache_path() 访问，
// 避免散落硬编码路径。关键数据源：tanks.pb + models.pb（BlitzKit 坦克数据库/模型定义，
// 运行时直接解析）、armor_cache.json / tank_cache.json / game_data/（便携装甲模型/碰撞盒）、
// cache/（运行时缓存：坦克 GLB、地图资产、封面图、地形高度场、截图）。
//
// 运行根目录（base_dir）：桌面/CLI 不设置 = 当前目录（语义与历史版本完全一致）；
// 移动端由 Tauri 入口在启动最早期 set_base_dir(应用私有目录)，此后所有相对路径
// （data/ 下的静态库/缓存/会话）自动落到私有目录。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// 数据根目录名（相对运行根目录）。
pub const DATA_DIR: &str = "data";

static BASE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 设置运行根目录（仅首次生效，重复调用返回 false）。
/// 必须在任何文件访问发生前调用（Tauri setup 最早期）。
pub fn set_base_dir(dir: PathBuf) -> bool {
    BASE_DIR.set(dir).is_ok()
}

/// 运行根目录（未设置时为当前目录 `.`，桌面/CLI 语义不变）。
pub fn base_dir() -> &'static Path {
    BASE_DIR.get().map(|p| p.as_path()).unwrap_or(Path::new("."))
}

/// 返回 `{base}/data/{name}` 的路径（`name` 可含子路径，如 `game_data/7169.json`）。
pub fn data_path(name: &str) -> PathBuf {
    base_dir().join(DATA_DIR).join(name)
}

/// 返回数据根目录 `{base}/data`。
pub fn data_dir() -> PathBuf {
    base_dir().join(DATA_DIR)
}

/// 返回运行根目录下的非 data 资产路径（
/// 不随数据目录收敛；此出口仅剩该用途）。
pub fn app_path(rel: &str) -> PathBuf {
    base_dir().join(rel)
}

/// 运行时缓存目录名（data/ 下，整体 gitignore；模型 GLB/地图资产/封面图/地形/截图）。
pub const CACHE_DIR: &str = "cache";

/// 返回 `{base}/data/cache/{rel}` 的路径（坦克 GLB、地图资产、封面图、地形高度场、截图）。
pub fn cache_path(rel: &str) -> PathBuf {
    data_path(CACHE_DIR).join(rel)
}

/// APK 内置资产读取钩子（移动端全量版由 Tauri 入口注入，经 JNI AssetManager 直读
/// APK 内资产；桌面/CLI 不注入恒为 None）。大资产（GLB/地形）不落盘、按需直读。
static EMBEDDED_ASSET_READER: OnceLock<fn(&str) -> Option<Vec<u8>>> = OnceLock::new();

/// 注入内置资产读取函数（仅首次生效）。必须在任何资产访问前调用。
pub fn set_embedded_asset_reader(f: fn(&str) -> Option<Vec<u8>>) -> bool {
    EMBEDDED_ASSET_READER.set(f).is_ok()
}

/// 读取 APK 内置资产（未注入或不存在的路径返回 None）。
pub fn read_embedded(rel: &str) -> Option<Vec<u8>> {
    EMBEDDED_ASSET_READER.get().and_then(|f| f(rel))
}

/// 共享资产读取：磁盘优先，APK 内置资产兜底（用于只读大资产，如 data/cache/maps 地图资产/地形）。
pub fn read_shareable(rel: &str) -> Option<Vec<u8>> {
    std::fs::read(app_path(rel)).ok().or_else(|| read_embedded(rel))
}
