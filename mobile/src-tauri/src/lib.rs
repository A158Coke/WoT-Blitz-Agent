//! WOTB Agent 移动端 Tauri 壳。
//!
//! 架构：WebView 加载 `http://tauri.localhost/`（Android）/ `tauri://localhost`（iOS），
//! 所有请求经自定义协议桥接进 axum Router（`wotb_agent::web::build_router`）——
//! 无真实本地端口，与桌面版同一套 Web GUI/回放/3D 查看器。
//!
//! 资产供给：打包资产树（prepare-assets.py 生成）由 sync 脚本放入 Android 工程
//! `app/src/main/assets/`（原生 assets，不经 tauri bundle.resources）。
//! - 小资产（data/、web/vendor、tank_images、地图底图）：首启经 JNI AssetManager
//!   解包到应用私有目录（清单 `resources-manifest.txt`）；
//! - 大资产（离线全量版 glb_cache）：不落盘，`data::set_embedded_asset_reader` 注入
//!   按需直读钩子（GLB 服务与地图地形读取处兜底）；
//! - 可写内容（模型缓存下载、会话、导入的回放）：app_data_dir。

use std::path::PathBuf;
use std::sync::OnceLock;

use tauri::Manager;

/// 全局 AppHandle：JNI 之外的场景备用（当前主要供桥接与命令使用）。
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// 内置资产清单（prepare-assets.py 生成；每行一个相对路径，只含小资产）。
const RESOURCES_MANIFEST: &str = include_str!("../resources-manifest.txt");

/// Android：经 JNI AssetManager 直读 APK 内 assets/（含全量版大资产，按需读取）。
///
/// 注意：Tauri 2 的 Android 运行时不初始化 ndk_context（实测启动即 panic），
/// 必须经 `webview.jni_handle().exec` 在 webview 线程上执行 JNI——exec 无返回值，
/// 用 channel 带回结果；闭包内 catch_unwind，任何 JNI 异常都降级为 None。
/// webview 的 JNI 句柄（桥接首个请求时注入；setup 阶段 webview 尚未就绪）。
#[cfg(target_os = "android")]
static JNI_EXEC: std::sync::OnceLock<tauri::wry::JniHandle> = std::sync::OnceLock::new();

#[cfg(target_os = "android")]
fn read_apk_asset(rel: &str) -> Option<Vec<u8>> {
    use std::sync::mpsc;
    use std::time::Duration;

    let jh = *JNI_EXEC.get()?;
    let (tx, rx) = mpsc::channel();
    let rel = rel.to_string();
    let job = move |env: &mut jni::JNIEnv, activity: &jni::objects::JObject, _webview: &jni::objects::JObject| {
        let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            read_asset_jni(env, activity, &rel)
        }))
        .ok()
        .flatten();
        // 资产不存在时 AssetManager.open 抛 Java 异常；不清除会沿调用栈上抛 → FATAL EXCEPTION
        let _ = env.exception_clear();
        let _ = tx.send(out);
    };
    jh.exec(job);
    rx.recv_timeout(Duration::from_secs(60)).ok().flatten()
}

/// 实际 JNI 读取：am.open(rel) → InputStream 全量读入 ByteArrayOutputStream。
#[cfg(target_os = "android")]
fn read_asset_jni(
    env: &mut jni::JNIEnv,
    activity: &jni::objects::JObject,
    rel: &str,
) -> Option<Vec<u8>> {
    use jni::objects::JValue;

    let am = env
        .call_method(activity, "getAssets", "()Landroid/content/res/AssetManager;", &[])
        .ok()?
        .l()
        .ok()?;
    let jrel = env.new_string(rel).ok()?;
    let stream = env
        .call_method(&am, "open", "(Ljava/lang/String;)Ljava/io/InputStream;", &[JValue::Object(&jrel)])
        .ok()?
        .l()
        .ok()?;
    jni_read_stream(env, &stream)
}

/// JNI 助手：把 Java InputStream 全量读入 Vec<u8>。
#[cfg(target_os = "android")]
fn jni_read_stream(env: &mut jni::JNIEnv, stream: &jni::objects::JObject) -> Option<Vec<u8>> {
    use jni::objects::JValue;

    let baos_class = env.find_class("java/io/ByteArrayOutputStream").ok()?;
    let baos = env.new_object(&baos_class, "()V", &[]).ok()?;
    let buf = env.new_byte_array(64 * 1024).ok()?;
    loop {
        let n = env
            .call_method(stream, "read", "([B)I", &[JValue::Object(&buf)])
            .ok()?
            .i()
            .ok()?;
        if n <= 0 {
            break;
        }
        env.call_method(&baos, "write", "([BII)V", &[
            JValue::Object(&buf),
            JValue::Int(0),
            JValue::Int(n),
        ]).ok()?;
    }
    let _ = env.call_method(stream, "close", "()V", &[]);
    let bytes = env
        .call_method(&baos, "toByteArray", "()[B", &[])
        .ok()?
        .l()
        .ok()?;
    let arr = jni::objects::JByteArray::from(bytes);
    let raw = env.convert_byte_array(&arr).ok()?;
    Some(raw.into_iter().map(|b| b as u8).collect())
}

/// SAF 选中的 content:// URI：经 ContentResolver 读取字节流，并查询 DISPLAY_NAME 作为文件名。
#[cfg(target_os = "android")]
fn read_uri_with_name(
    env: &mut jni::JNIEnv,
    activity: &jni::objects::JObject,
    uri_str: &str,
) -> Option<(Option<String>, Vec<u8>)> {
    use jni::objects::{JObject, JValue};

    let jstr = env.new_string(uri_str).ok()?;
    let uri = env
        .call_static_method(
            "android/net/Uri",
            "parse",
            "(Ljava/lang/String;)Landroid/net/Uri;",
            &[JValue::Object(&jstr)],
        )
        .ok()?
        .l()
        .ok()?;
    let cr = env
        .call_method(activity, "getContentResolver", "()Landroid/content/ContentResolver;", &[])
        .ok()?
        .l()
        .ok()?;

    // 查询 DISPLAY_NAME（真实文件名）
    let mut display_name: Option<String> = None;
    let null = JObject::null();
    if let Ok(cursor) = env
        .call_method(&cr, "query",
            "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
            &[JValue::Object(&uri), JValue::Object(&null), JValue::Object(&null), JValue::Object(&null), JValue::Object(&null)],
        )
        .and_then(|v| v.l())
    {
        let _ = env.exception_clear();
        if let Ok(true) = env.call_method(&cursor, "moveToFirst", "()Z", &[]).and_then(|v| v.z()) {
            let col = env.new_string("_display_name").ok()?;
            if let Ok(idx) = env.call_method(&cursor, "getColumnIndex", "(Ljava/lang/String;)I", &[JValue::Object(&col)]).and_then(|v| v.i()) {
                if idx >= 0 {
                    if let Ok(sobj) = env.call_method(&cursor, "getString", "(I)Ljava/lang/String;", &[JValue::Int(idx)]).and_then(|v| v.l()) {
                        let js = jni::objects::JString::from(sobj);
                        if let Ok(java_str) = env.get_string(&js) {
                            display_name = Some(java_str.to_string_lossy().into_owned());
                        };
                    };
                }
            }
        }
        let _ = env.call_method(&cursor, "close", "()V", &[]);
        let _ = env.exception_clear();
    }

    let stream = env
        .call_method(&cr, "openInputStream", "(Landroid/net/Uri;)Ljava/io/InputStream;", &[JValue::Object(&uri)])
        .ok()?
        .l()
        .ok()?;
    let data = jni_read_stream(env, &stream)?;
    Some((display_name, data))
}

/// 在 webview 线程执行 ContentResolver 读取（exec + channel 回传）。
#[cfg(target_os = "android")]
fn read_content_uri_with_name(uri: &str) -> Result<(Option<String>, Vec<u8>), String> {
    let jh = *JNI_EXEC.get().ok_or("WebView JNI 尚未就绪")?;
    let (tx, rx) = std::sync::mpsc::channel();
    let uri = uri.to_string();
    jh.exec(move |env, activity, _webview| {
        let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            read_uri_with_name(env, activity, &uri)
        }))
        .ok()
        .flatten();
        let _ = env.exception_clear();
        let _ = tx.send(out);
    });
    rx.recv_timeout(std::time::Duration::from_secs(120))
        .map_err(|_| "读取超时".to_string())?
        .ok_or_else(|| "无法读取所选文件".to_string())
}

/// 非 Android 平台：无 APK 资产（桌面调试走仓库根目录文件）。
#[cfg(not(target_os = "android"))]
fn read_apk_asset(_rel: &str) -> Option<Vec<u8>> {
    None
}

/// 小资产解包状态（惰性单次：setup 阶段 webview 线程未就绪，exec 会死等，故首个请求时触发）。
static PROVISION_STATE: std::sync::Mutex<bool> = std::sync::Mutex::new(false);

fn provision_assets_once(data_dir: &std::path::Path) {
    let mut done = PROVISION_STATE.lock().unwrap();
    if *done {
        return;
    }
    let n = provision_assets(data_dir);
    *done = true;
    log::info!("[provision] extracted {n} files to {}", data_dir.display());
}

/// 解包小资产到私有目录（已存在的文件跳过 → 增量升级语义）。返回实际解包数。
fn provision_assets(data_dir: &std::path::Path) -> usize {
    let mut n = 0usize;
    for line in RESOURCES_MANIFEST.lines() {
        let rel = line.trim();
        if rel.is_empty() || rel.starts_with('#') {
            continue;
        }
        let dest = data_dir.join(rel);
        if dest.exists() {
            continue;
        }
        if let Some(bytes) = read_apk_asset(rel) {
            if let Some(parent) = dest.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if std::fs::write(&dest, &bytes).is_ok() {
                n += 1;
            }
        }
    }
    n
}

/// 生成移动端默认 config.toml（replay_dir 指向私有 replays/，路径转换关闭）。
fn ensure_config(data_dir: &std::path::Path) -> PathBuf {
    let p = data_dir.join("config.toml");
    if !p.exists() {
        let fwd = |rel: PathBuf| rel.to_string_lossy().replace('\\', "/");
        let cfg = format!(
            "[wg_api]\napplication_id = \"9eeca6d62dfc4b1d8539ee5a76d0bf55\"\nserver = \"asia\"\n\n\
             [llm]\nendpoint = \"https://api.openai.com/v1\"\napi_key = \"\"\nmodel = \"glm-5\"\n\
             context_length = 8192\nthinking_mode = false\nprice_input_per_1k = 0.0\n\
             price_output_per_1k = 0.0\nmax_tokens = 4096\nbudget = 10.0\n\n\
             [replay]\nreplay_dir = \"{}\"\npath_translate = \"off\"\ntank_cache_path = \"{}\"\n",
            fwd(data_dir.join("replays")),
            fwd(data_dir.join("data/tank_cache.json")),
        );
        let _ = std::fs::write(&p, cfg);
    }
    p
}

/// 桥接路由的受管状态。
struct BridgeState {
    router: axum::Router,
}

/// 把 axum Router 桥接到 Tauri 自定义协议（所有 tauri.localhost 请求）。
fn bridge_protocol(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    use tower::util::ServiceExt;

    builder.register_asynchronous_uri_scheme_protocol("tauri", move |ctx, request, responder| {
        let app = ctx.app_handle().clone();
        tauri::async_runtime::spawn(async move {
            // 注入 webview 线程 JNI 执行器（首个请求时 webview 已就绪），随后触发惰性解包。
            // with_webview 异步在 webview 线程执行，这里短暂等待注入完成。
            #[cfg(target_os = "android")]
            if JNI_EXEC.get().is_none() {
                if let Some(wv) = app.webview_windows().values().next().cloned() {
                    let _ = wv.with_webview(move |platform| {
                        let _ = JNI_EXEC.set(platform.jni_handle());
                    });
                }
                for _ in 0..200 {
                    if JNI_EXEC.get().is_some() { break; }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                if let Ok(dir) = app.path().app_data_dir() {
                    provision_assets_once(&dir);
                }
            }

            let router = {
                let state = app.state::<BridgeState>();
                state.router.clone()
            };

            let (parts, body) = request.into_parts();
            // WebView 首页固定加载 index.html → 重写为仪表盘根路径
            let path = if parts.uri.path() == "/index.html" {
                "/".to_string()
            } else {
                parts
                    .uri
                    .path_and_query()
                    .map(|pq| pq.as_str().to_string())
                    .unwrap_or_else(|| "/".into())
            };

            let logged_path = path.clone();
            let mut builder = axum::http::Request::builder()
                .method(parts.method.clone())
                .uri(path);
            for (k, v) in parts.headers.iter() {
                if k != axum::http::header::HOST && k != axum::http::header::CONTENT_LENGTH {
                    builder = builder.header(k, v);
                }
            }
            let req = match builder.body(axum::body::Body::from(body)) {
                Ok(r) => r,
                Err(_) => {
                    responder.respond(
                        axum::http::Response::builder()
                            .status(400)
                            .body(Vec::new())
                            .unwrap(),
                    );
                    return;
                }
            };

            let response = match router.oneshot(req).await {
                Ok(resp) => resp,
                Err(e) => {
                    eprintln!("[bridge] {} {logged_path} -> router error: {e}", parts.method);
                    responder.respond(
                        axum::http::Response::builder()
                            .status(500)
                            .body(Vec::new())
                            .unwrap(),
                    );
                    return;
                }
            };

            let (rp, rb) = response.into_parts();
            let bytes = axum::body::to_bytes(rb, 512 * 1024 * 1024)
                .await
                .unwrap_or_default()
                .to_vec();
            eprintln!("[bridge] {} {} -> {}", parts.method, logged_path, rp.status);
            let mut out = axum::http::Response::builder().status(rp.status);
            for (k, v) in rp.headers.iter() {
                if k != axum::http::header::CONTENT_LENGTH
                    && k != axum::http::header::TRANSFER_ENCODING
                {
                    out = out.header(k, v);
                }
            }
            responder.respond(out.body(bytes).unwrap_or_default());
        });
    })
}

/// POST 通道：Android WebView 的协议拦截拿不到请求体（shouldInterceptRequest 限制），
/// 前端 fetch shim 把所有 POST 改道为 invoke('bridge_post')，在 Rust 侧直接过 axum Router。
/// 返回 base64 编码的原始响应（兼容 gzip 响应体），由前端还原为 Response。
#[tauri::command]
async fn bridge_post(
    state: tauri::State<'_, BridgeState>,
    path: String,
    body: String,
) -> Result<serde_json::Value, String> {
    use tower::util::ServiceExt;

    let req = axum::http::Request::builder()
        .method(axum::http::Method::POST)
        .uri(path)
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(body))
        .map_err(|e| e.to_string())?;

    let response = state
        .router
        .clone()
        .oneshot(req)
        .await
        .map_err(|e| e.to_string())?;

    let (rp, rb) = response.into_parts();
    let mut bytes = axum::body::to_bytes(rb, 512 * 1024 * 1024)
        .await
        .map_err(|e| e.to_string())?
        .to_vec();
    // gzip 响应就地解压：手工构造的 Response 不会被浏览器透明解压，gzip 字节会让 r.json() 失败
    let is_gzip = rp.headers.get(axum::http::header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok()).map(|v| v.contains("gzip")).unwrap_or(false);
    if is_gzip {
        let mut decoder = flate2::read::GzDecoder::new(&bytes[..]);
        let mut plain = Vec::new();
        std::io::Read::read_to_end(&mut decoder, &mut plain).map_err(|e| e.to_string())?;
        bytes = plain;
    }
    use base64::Engine as _;
    Ok(serde_json::json!({
        "status": rp.status.as_u16(),
        "contentType": rp.headers.get(axum::http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()).unwrap_or("application/json"),
        "body": base64::engine::general_purpose::STANDARD.encode(&bytes),
    }))
}

/// 从系统文件选择器选中的内容导入 .wotbreplay 到私有 replays/（返回目标路径）。
/// Android 上 SAF 返回 content:// URI（非真实路径），经 ContentResolver 读出字节流；
/// 普通文件路径（桌面调试）直接复制。
#[tauri::command]
fn import_replay(app: tauri::AppHandle, src: String) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("replays");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let (mut name, data) = if src.starts_with("content:") {
        #[cfg(target_os = "android")]
        {
            let (name_opt, data) = read_content_uri_with_name(&src)?;
            (name_opt.unwrap_or_default(), data)
        }
        #[cfg(not(target_os = "android"))]
        {
            return Err("content:// 导入仅支持 Android".into());
        }
    } else {
        let src_path = PathBuf::from(&src);
        let name = src_path
            .file_name()
            .ok_or_else(|| "invalid source path".to_string())?
            .to_string_lossy()
            .to_string();
        let data = std::fs::read(&src_path).map_err(|e| format!("read failed: {e}"))?;
        (name, data)
    };

    // 文件名清洗：DISPLAY_NAME 缺失/纯数字（Download 的 document id）时用时间戳兜底，统一补后缀
    if name.is_empty() || name.chars().all(|c| c.is_ascii_digit()) {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        name = format!("imported_{ts}.wotbreplay");
    }
    if !name.ends_with(".wotbreplay") {
        name.push_str(".wotbreplay");
    }

    let dest = dir.join(&name);
    std::fs::write(&dest, &data).map_err(|e| format!("save failed: {e}"))?;
    Ok(dest.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 桌面 debug 构建直接指向仓库根（真实 data/、glb_cache/），便于在 PC 上调试完整链路
            #[cfg(all(debug_assertions, not(target_os = "android")))]
            let data_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
            #[cfg(any(not(debug_assertions), target_os = "android"))]
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("no app data dir on this platform");
            std::fs::create_dir_all(data_dir.join("replays")).ok();
            std::fs::create_dir_all(data_dir.join("data/sessions")).ok();

            // 运行目录重定向必须在任何文件访问之前
            wotb_agent::data::set_base_dir(data_dir.clone());
            let _ = wotb_agent::data::set_embedded_asset_reader(read_apk_asset);
            let _ = APP.set(app.handle().clone());

            let config_path = ensure_config(&data_dir);

            let router = wotb_agent::web::build_router(
                config_path,
                wotb_agent::data::data_path("sessions"),
            );
            app.manage(BridgeState { router });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![import_replay, bridge_post]);

    bridge_protocol(builder)
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {});
}
