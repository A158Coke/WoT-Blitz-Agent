use axum::{routing::{get, post}, response::{IntoResponse, Response}, Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::path::Path;
use crate::wargaming::tank_resolver::TankResolver;
use crate::wargaming::dvpl::ArmorModel;
use crate::wargaming::penetration::{self, PenetrationRequest};

const GLB_CACHE_DIR: &str = "cache/models";
const GLB_FILES: [&str; 2] = ["collision.glb", "model.glb"];

fn wsl_ip() -> String {
    std::process::Command::new("hostname")
        .arg("-I")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.split_whitespace().next().map(|s| s.to_string()))
        .unwrap_or_else(|| "localhost".to_string())
}

/// 从 models.pb 合成精确装甲模型（逐板厚度/spaced/履带厚度，BlitzKit 唯一来源）。
/// primaryArmor 是 BlitzKit 缺项，从 game_data 同节段拷贝（缺失时留空串——仅影响展示，
/// 装甲摘要链走 game_data 原路径不受影响）；炮塔/主炮取顶级配置（最后炮塔×最后炮），
/// 与 game_data 的 XML 顶级配置语义对齐。
pub(crate) fn synth_armor_model(tank_id: u32) -> Option<ArmorModel> {
    let mi = crate::wargaming::blitzkit::model_info(tank_id)?;
    let game_am = crate::wargaming::game_extract::load_game_data(
        tank_id, &crate::data::data_dir().join("game_data"))
        .and_then(|gd| gd.armor_model);
    let section = |plates: &std::collections::BTreeMap<u32, f32>, spaced: &[u32],
                   primary: Option<&crate::wargaming::dvpl::PrimaryArmor>| {
        crate::wargaming::dvpl::SectionArmor {
            plates: plates.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
            primary: primary.cloned().unwrap_or(crate::wargaming::dvpl::PrimaryArmor {
                front: String::new(), sides: String::new(), rear: String::new(),
            }),
            spaced: spaced.iter().map(|s| s.to_string()).collect(),
        }
    };
    let top_module = crate::wargaming::blitzkit::tank_full(tank_id)
        .and_then(|t| t.turrets.last().map(|t2| t2.module_id));
    let top_turret = mi.turrets.iter().find(|t| Some(t.module_id) == top_module)
        .or_else(|| mi.turrets.last());
    Some(ArmorModel {
        hull: section(&mi.hull_plates, &mi.hull_spaced,
            game_am.as_ref().map(|am| &am.hull.primary)),
        turret: top_turret.map(|t| section(&t.turret_plates, &t.turret_spaced,
            game_am.as_ref().and_then(|am| am.turret.as_ref()).map(|s| &s.primary))),
        gun: top_turret.and_then(|t| t.guns.last()).map(|g| section(&g.gun_plates, &g.gun_spaced,
            game_am.as_ref().and_then(|am| am.gun.as_ref()).map(|s| &s.primary))),
        chassis: mi.track_thickness.map(|t| crate::wargaming::dvpl::ChassisArmor {
            left_track: t, right_track: t,
        }),
    })
}

static GLOBAL_RESOLVER: std::sync::OnceLock<Arc<TankResolver>> = std::sync::OnceLock::new();

pub fn global_resolver() -> Arc<TankResolver> {
    GLOBAL_RESOLVER.get_or_init(|| {
        TankResolver::load_from_json_file(&crate::data::data_path("tank_cache.json"))
            .map(Arc::new)
            .unwrap_or_default()
    }).clone()
}

pub fn set_global_resolver(resolver: TankResolver) {
    let _ = GLOBAL_RESOLVER.set(Arc::new(resolver));
}

pub async fn serve(tank_resolver: TankResolver, tank_id: u32, shooter_id: Option<u32>) -> anyhow::Result<()> {
    let app = build_viewer_router(tank_resolver, tank_id, shooter_id, "");

    let addr = SocketAddr::from(([0, 0, 0, 0], 0));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let local_addr = listener.local_addr()?;

    let url = format!("http://127.0.0.1:{}", local_addr.port());

    eprintln!("Server running at {}", url);
    eprintln!("If browser doesn't open, try: http://localhost:{} or http://{}:{}",
        local_addr.port(), wsl_ip(), local_addr.port());
    eprintln!("Opening browser...");

    if webbrowser::open(&url).is_err() {
        eprintln!("Please open {} in your browser manually.", url);
    }

    axum::serve(listener, app).await?;

    Ok(())
}

pub fn build_viewer_router(
    tank_resolver: TankResolver,
    tank_id: u32,
    shooter_id: Option<u32>,
    base_prefix: &str,
) -> axum::Router {
    set_global_resolver(tank_resolver);

    // 页面已切流至 Vue SPA（crate::web 嵌入产物）；根路径重定向到检视路由
    let _ = base_prefix;
    let redirect_target = match shooter_id {
        Some(s) if s != tank_id => format!("/armor_view/view/{tank_id}?shooter={s}"),
        _ => format!("/armor_view/view/{tank_id}"),
    };
    Router::new()
        .route("/", get(move || {
            let target = redirect_target.clone();
            async move { axum::response::Redirect::temporary(&target) }
        }))
        .route("/armor_view/view/{tank_id}", get(|| async { crate::web::spa_index_response() }))
        .route("/assets/{*path}", get(|axum::extract::Path(path): axum::extract::Path<String>| async move {
            crate::web::spa_asset_response(&path)
        }))
        .route("/glb/{tank_id}/{filename}", get(glb_handler))
        .route("/api/tank/{tank_id}", get(tank_data_handler))
        .route("/api/tank_filter", get(tank_filter_handler))
        .route("/api/tank_image/{tank_id}", get(tank_image_handler))
        .route("/api/shells/{tank_id}", get(shells_handler))
        .route("/api/penetrate", post(penetrate_handler))
        .route("/api/hold", get(crate::wargaming::heatmap_ready::hold_handler))
        .route("/api/ready", get(crate::wargaming::heatmap_ready::ready_handler))
        .with_state(())
}

/// 单个 GLB 的缓存路径（data/cache/models/{tank_id}/{filename}），按需服务与 fetch-models 全量预热共用。
pub(crate) fn model_cache_path(tank_id: u32, filename: &str) -> std::path::PathBuf {
    crate::data::data_path(GLB_CACHE_DIR).join(tank_id.to_string()).join(filename)
}

pub(crate) async fn ensure_glb_bytes(tank_id: u32, filename: &str) -> Result<Vec<u8>, String> {
    if !GLB_FILES.contains(&filename) {
        return Err(format!("invalid GLB filename: {}", filename));
    }
    let cache_path = model_cache_path(tank_id, filename);
    let cache_dir = cache_path.parent().map(Path::to_path_buf).unwrap_or_else(|| crate::data::data_path(GLB_CACHE_DIR));
    if let Ok(bytes) = std::fs::read(&cache_path) {
        // 损坏自愈：无 glTF magic（截断/HTML 错误页）视作未命中，走重下覆盖
        if bytes.starts_with(b"glTF") {
            return Ok(bytes);
        }
        eprintln!("[glb-cache] 缓存文件损坏（缺 glTF magic），重新下载: {}", cache_path.display());
    }
    // APK 内置资产兜底（移动端离线全量版）：直读不落盘，避免 1.9GB 复制
    if let Some(bytes) = crate::data::read_embedded(&format!("data/cache/models/{tank_id}/{filename}")) {
        if bytes.starts_with(b"glTF") {
            return Ok(bytes);
        }
    }

    let url = format!("https://api.blitzkit.app/tanks/{}/{}", tank_id, filename);
    eprintln!("[glb-cache] downloading {} ...", url);
    // Client 进程级复用（连接池跨请求共享；此前每次调用重建，池形同虚设）
    let client = glb_http_client();
    let mut last_err;   // 循环内每个分支都会先赋值
    for _attempt in 0..3 {
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                match resp.bytes().await {
                    Ok(bytes) => {
                        let vec = bytes.to_vec();
                        if !vec.starts_with(b"glTF") {
                            last_err = "响应体不是合法 GLB（缺 glTF magic）".to_string();
                        } else {
                            let _ = std::fs::create_dir_all(&cache_dir);
                            match std::fs::write(&cache_path, &vec) {
                                Ok(_) => eprintln!("[glb-cache] cached {} ({} bytes)", cache_path.display(), vec.len()),
                                Err(e) => eprintln!("[glb-cache] cache write failed: {}", e),
                            }
                            return Ok(vec);
                        }
                    }
                    Err(e) => last_err = format!("read body failed: {}", e),
                }
            }
            Ok(resp) if resp.status() == reqwest::StatusCode::NOT_FOUND => {
                // 确定性 404：该车辆在 CDN 无此模型文件，重试与 curl 回退都无意义
                // （批量预热遇到大量缺失车辆时，逐个重试会拖慢整体进度）
                return Err(format!("BlitzKit CDN 404: {url} (模型不存在)"));
            }
            Ok(resp) => last_err = format!("BlitzKit CDN returned {}", resp.status()),
            Err(e) => last_err = format!("{}", e),
        }
        eprintln!("[glb-cache] attempt failed, retrying... ({last_err})");
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    // reqwest 全部重试失败 → 系统 curl 回退。实测（GFW 环境）rustls 指纹的大文件
    // 流会被中途重置（reqwest 报 read body failed: error decoding response body），
    // 而 curl（不同 TLS 栈）可完整拉取同一资源。
    eprintln!("[glb-cache] reqwest 失败，尝试系统 curl 回退...");
    let tmp_path = cache_path.with_extension("download");
    // tokio 异步子进程（此前 std::process 同步 output() 会在 async worker 上挂最长
    // --max-time 180s，回源失败时占死 worker）
    let out = tokio::process::Command::new("curl")
        .args([
            "-sfL", "--max-time", "180",
            "-o", tmp_path.to_string_lossy().as_ref(),
            &url,
        ])
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() && tmp_path.exists() => {
            match std::fs::read(&tmp_path) {
                Ok(bytes) if !bytes.is_empty() && bytes.starts_with(b"glTF") => {
                    let _ = std::fs::create_dir_all(&cache_dir);
                    let _ = std::fs::write(&cache_path, &bytes);
                    let _ = std::fs::remove_file(&tmp_path);
                    eprintln!("[glb-cache] curl 回退成功，已入缓存 {} ({} bytes)", cache_path.display(), bytes.len());
                    return Ok(bytes);
                }
                Ok(bytes) if !bytes.is_empty() => last_err = "curl 回退：响应体不是合法 GLB（缺 glTF magic）".to_string(),
                Ok(_) => last_err = "curl 回退：响应体为空".to_string(),
                Err(e) => last_err = format!("curl 回退：读取失败 {}", e),
            }
        }
        Ok(o) => {
            last_err = format!(
                "curl 回退失败（exit {:?}: {}）",
                o.status.code(),
                String::from_utf8_lossy(&o.stderr).chars().take(200).collect::<String>()
            );
        }
        Err(e) => last_err = format!("curl 回退不可用: {}", e),
    }
    let _ = std::fs::remove_file(&tmp_path);
    Err(format!("BlitzKit CDN unreachable: {last_err} (model not in data/cache/models/)"))
}

pub async fn start_viewer_server(tank_resolver: TankResolver, tank_id: u32, shooter_id: u32) -> anyhow::Result<u16> {
    start_viewer_server_with_data(tank_resolver, tank_id, Some(shooter_id), None).await
}

/// 为回放射击复现启动无头查看器：解析回放 → 挂载 /api/replay_shot → 返回
/// (端口, shell 弹表下标, 目标实际配置下标)。shell 参数按发射弹种 shell_id 在
/// 射手弹表中的确定性下标传递（type=28 槽位快照存在切弹竞态，仅作兜底）；
/// 配置下标供 `&config=N` 选择目标/射手模型的炮塔/主炮变体。
pub async fn start_viewer_server_for_replay(
    replay_path: &std::path::Path,
    tank_resolver: TankResolver,
    shot_no: usize,
) -> anyhow::Result<(u16, u32, Option<usize>)> {
    use wotbreplay_parser::replay::Replay;
    let mut replay = Replay::open(std::fs::File::open(replay_path)?)?;
    let meta = replay.read_meta().ok();
    let data = replay.read_data()?;
    let raw_packets: Vec<(u32, f32, &[u8])> = data.packets.iter().map(|pkt| {
        let t = match &pkt.payload {
            wotbreplay_parser::models::data::payload::Payload::BasePlayerCreate { .. } => 0,
            wotbreplay_parser::models::data::payload::Payload::EntityMethod(_) => 8,
            wotbreplay_parser::models::data::payload::Payload::Unknown { packet_type } => *packet_type,
        };
        (t, pkt.clock_secs, &pkt.raw_payload[..])
    }).collect();

    let timeline = crate::replay::combat::CombatTimeline::parse_packets(&raw_packets);
    // 先把带 DamageCounter 事件的 entity_id 收进 HashSet，避免对每个候选实体
    // 重新全量扫描 events（O(N×M) → O(N+M)）
    let dmg_counter_eids: std::collections::HashSet<u32> = timeline.events.iter()
        .filter(|e| matches!(e.event_type, crate::replay::combat::CombatEventType::DamageCounter { .. }))
        .map(|e| e.entity_id)
        .collect();
    let author_eid = *timeline.entity_names.iter()
        .find(|(eid, _)| dmg_counter_eids.contains(eid))
        .map(|(eid, _)| eid)
        .unwrap_or(&0);
    let shots = timeline.infer_shots(author_eid);
    if shots.is_empty() {
        return Err(anyhow::anyhow!("No shot events detected in this replay."));
    }
    // 作者昵称 = battle_results 权威来源（meta.json 非 UTF-8 时 read_meta 整体失败，不可依赖；
    // meta.player_name 仅作兜底）
    let br = replay.read_battle_results().ok();
    let author_nickname = br.as_ref()
        .map(crate::replay::combat::author_nick_from_battle_results)
        .or_else(|| meta.as_ref().map(|m| m.player_name.clone()))
        .unwrap_or_default();
    let author_player_eid = crate::replay::combat::resolve_author_player_eid_by_nick(&raw_packets, &author_nickname);
    // 双方炮管俯仰的车型极限锚定表（昵称→俯角/仰角）——prop2 frac 比例解码用；
    // 实际搭载 comp blob 一并收集（锚定与每发配置下标共用）
    let valid_tanks: Vec<u32> = br.as_ref().map(|br| br.player_results.iter()
        .map(|pr| pr.info.tank_id).collect()).unwrap_or_default();
    let comps = crate::replay::playback::collect_comp_descriptors(&raw_packets, &valid_tanks);
    let pitch_limits = br.as_ref()
        .map(|br| tank_resolver.pitch_limits_from_battle_results(br, &comps))
        .unwrap_or_default();
    let tank_of = |nick: &str| -> Option<u32> {
        let br = br.as_ref()?;
        br.players.iter().find(|p| p.info.nickname == nick)
            .and_then(|p| br.player_results.iter().find(|pr| pr.info.account_id == p.account_id))
            .map(|pr| pr.info.tank_id)
    };
    let mut replay_data = crate::replay::combat::extract_shot_replays_with_limits(&raw_packets, author_player_eid, &pitch_limits)?;
    // 弹种回填：全局 shell_id → tanks.pb 原始弹种串（/api/replay_shot 透传给 3D 视图）
    crate::replay::loadout::ShellKindTable::from_tanks_pb().annotate(&mut replay_data);
    if shot_no == 0 || shot_no > replay_data.len() {
        return Err(anyhow::anyhow!("shot {} out of range (1..={})", shot_no, replay_data.len()));
    }
    let shot = &replay_data[shot_no - 1];
    let target_tank = tank_of(&shot.target_name);
    let author_nickname = meta.as_ref().map(|m| m.player_name.clone()).unwrap_or_default();
    let shooter_tank = tank_of(&author_nickname)
        .or_else(|| meta.as_ref().map(|m| m.tank_id as u32).filter(|v| *v > 0));
    eprintln!("[replay_shot] shot={}_{} target_name={} target_tank={:?} shooter_tank={:?} target_ang={:?}",
        shot_no, shot.damage, shot.target_name, target_tank, shooter_tank, shot.target_ang);

    let viewed_tank = target_tank.or(shooter_tank).unwrap_or(0);
    let shell_slot = shot.shell_slot;
    // 发射弹种的权威标识 = shell_id（type=28 槽位快照存在切弹竞态）；
    // URL 的 shell 参数按「弹种在射手弹表中的下标」传递
    let shell_for_url = shooter_tank
        .and_then(|st| shell_index_by_global_id(st, shot.shell_id))
        .map(|i| i as u32)
        .unwrap_or(shell_slot);
    // 实际搭载配置下标（目标/射手）：comp blob → 发射弹种 → 初始血量 证据链，注入每发数据
    //（comps 已在俯仰锚定表构建时收集）
    let initial_hp_all = crate::replay::combat::collect_initial_hp(&raw_packets);
    let mut player_shells: std::collections::HashMap<String, Vec<u32>> = std::collections::HashMap::new();
    for s in &replay_data {
        if s.shell_id == 0 { continue; }
        let v = player_shells.entry(s.shooter_name.clone()).or_default();
        if !v.contains(&s.shell_id) { v.push(s.shell_id); }
    }
    let mut nick_hp: std::collections::HashMap<String, u16> = std::collections::HashMap::new();
    for (eid, nick) in &timeline.entity_names {
        if let Some((_, hp)) = initial_hp_all.get(eid) { nick_hp.insert(nick.clone(), *hp); }
    }
    let cfg_of = |nick: &str, tank: u32| -> Option<usize> {
        if tank == 0 { return None; }
        let comp = comps.get(nick).and_then(|c| {
            ((c.tank_id & 0xFFFF) == (tank & 0xFFFF)).then_some((c.turret_local, c.gun_local))
        });
        let shells = player_shells.get(nick).map(|v| v.as_slice()).unwrap_or(&[]);
        let hp = nick_hp.get(nick).copied().unwrap_or(0);
        resolve_config_index(tank, comp, shells, hp).map(|(idx, _, _)| idx)
    };
    let viewed_cfg = if let Some(tt) = target_tank {
        cfg_of(&shot.target_name, tt)
    } else {
        shooter_tank.and_then(|st| cfg_of(&author_nickname, st))
    };
    let mut replay_json = serde_json::to_value(&replay_data)?;
    if let Some(arr) = replay_json.as_array_mut() {
        for s in arr.iter_mut() {
            let shooter_name = s["shooter_name"].as_str().unwrap_or("").to_string();
            let target_name = s["target_name"].as_str().unwrap_or("").to_string();
            if let Some(idx) = tank_of(&shooter_name).and_then(|t| cfg_of(&shooter_name, t)) {
                s["shooter_config_idx"] = json!(idx);
            }
            if let Some(idx) = tank_of(&target_name).and_then(|t| cfg_of(&target_name, t)) {
                s["target_config_idx"] = json!(idx);
            }
            let shell_id = s["shell_id"].as_u64().unwrap_or(0) as u32;
            if let Some(st) = tank_of(&shooter_name) {
                if shell_id != 0 {
                    if let Some(si) = shell_index_by_global_id(st, shell_id) {
                        s["shooter_shell_idx"] = json!(si);
                    }
                }
            }
        }
    }
    eprintln!("[replay_shot] 配置下标注入完成（shot={}，viewed_cfg={:?}）", shot_no, viewed_cfg);
    let port = start_viewer_server_with_data(tank_resolver, viewed_tank, shooter_tank, Some(replay_json)).await?;
    Ok((port, shell_for_url, viewed_cfg))
}

pub async fn start_viewer_server_with_data(
    tank_resolver: TankResolver,
    tank_id: u32,
    shooter_id: Option<u32>,
    replay_shots: Option<serde_json::Value>,
) -> anyhow::Result<u16> {
    let mut app = build_viewer_router(tank_resolver, tank_id, shooter_id, "");
    if let Some(shots) = replay_shots {
        app = app.route("/api/replay_shot", get(move || {
            let shots = shots.clone();
            async move { Json(shots) }
        }));
    }
    let listener = tokio::net::TcpListener::bind("0.0.0.0:0").await?;
    let port = listener.local_addr()?.port();
    eprintln!("[viewer] serving tank {} (shooter {:?}) on http://127.0.0.1:{} (headless)", tank_id, shooter_id, port);
    tokio::spawn(async move { let _ = axum::serve(listener, app).await; });
    Ok(port)
}

pub(crate) async fn glb_handler(
    axum::extract::Path((tank_id, filename)): axum::extract::Path<(u32, String)>,
) -> Response {
    match ensure_glb_bytes(tank_id, &filename).await {
        Ok(bytes) => glb_response(bytes),
        Err(msg) => (axum::http::StatusCode::BAD_GATEWAY, msg).into_response(),
    }
}

fn glb_response(bytes: Vec<u8>) -> Response {
    (
        [(axum::http::header::CONTENT_TYPE, "model/gltf-binary")],
        bytes,
    ).into_response()
}

const TANK_IMAGE_DIR: &str = "cache/tank_images";

pub(crate) async fn tank_image_handler(axum::extract::Path(tank_id): axum::extract::Path<u32>) -> Response {
    let cache_path = crate::data::data_path(TANK_IMAGE_DIR).join(format!("{}.webp", tank_id));
    if let Ok(bytes) = std::fs::read(&cache_path) {
        return image_response(bytes);
    }

    let url = format!("https://api.blitzkit.app/tanks/{}/icons/big.webp", tank_id);
    match reqwest::get(&url).await {
        Ok(resp) if resp.status().is_success() => {
            match resp.bytes().await {
                Ok(bytes) => {
                    let vec = bytes.to_vec();
                    let _ = std::fs::create_dir_all(crate::data::data_path(TANK_IMAGE_DIR));
                    if std::fs::write(&cache_path, &vec).is_ok() {
                        eprintln!("[image-cache] cached {} ({} bytes)", cache_path.display(), vec.len());
                    }
                    image_response(vec)
                }
                Err(e) => (axum::http::StatusCode::BAD_GATEWAY, format!("image download failed: {}", e)).into_response(),
            }
        }
        Ok(resp) => (
            axum::http::StatusCode::BAD_GATEWAY,
            format!("BlitzKit icon returned {}", resp.status()),
        ).into_response(),
        Err(e) => (
            axum::http::StatusCode::BAD_GATEWAY,
            format!("BlitzKit icon unreachable: {}", e),
        ).into_response(),
    }
}

fn image_response(bytes: Vec<u8>) -> Response {
    (
        [(axum::http::header::CONTENT_TYPE, "image/webp")],
        bytes,
    ).into_response()
}


pub(crate) async fn penetrate_handler(Json(req): Json<PenetrationRequest>) -> Json<Value> {
    let result = penetration::calculate(&req);
    Json(serde_json::to_value(result).unwrap_or(json!(null)))
}

pub(crate) async fn tank_data_handler(
    axum::extract::Path(tank_id): axum::extract::Path<u32>,
) -> Json<Value> {
    Json(tank_data_value(tank_id))
}

pub(crate) fn tank_data_value(tank_id: u32) -> Value {
    tank_data_value_prefixed(tank_id, "")
}

pub(crate) fn tank_data_value_prefixed(tank_id: u32, base_prefix: &str) -> Value {
    let resolver = global_resolver();

    let info = resolver.resolve_info(tank_id);

    // C 类数据：炮管/底盘碰撞盒仍取本机客户端提取（BlitzKit 无对应数据）
    let game_data = crate::wargaming::game_extract::load_game_data(tank_id, &crate::data::data_dir().join("game_data"));
    // 逐板装甲：BlitzKit models.pb 唯一来源（primary 为 BlitzKit 缺项，合成时从 game_data 拷贝）
    let armor_model = synth_armor_model(tank_id);

    let name = resolver
        .resolve(tank_id)
        .unwrap_or_else(|| format!("tank_{}", tank_id));
    let tier = info
        .as_ref()
        .map(|i| i.tier as u32)
        .filter(|t| *t > 0)
        .unwrap_or(0);
    let tank_type = info
        .as_ref()
        .map(|i| i.tank_type.clone())
        .filter(|t| !t.is_empty() && t != "unknown")
        .unwrap_or_else(|| "unknown".to_string());
    let nation = info
        .as_ref()
        .map(|i| i.nation.clone())
        .filter(|n| !n.is_empty() && n != "unknown")
        .unwrap_or_else(|| "unknown".to_string());

    let armor = info.as_ref().and_then(|i| i.armor.as_ref()).map(|a| json!({
        "turret": {"front": a.turret_front, "sides": a.turret_sides, "rear": a.turret_rear},
        "hull": {"front": a.hull_front, "sides": a.hull_sides, "rear": a.hull_rear},
    }));

    let shells = info.as_ref().map(|i| {
        i.shells.iter().map(|s| json!({
            "type": s.shell_type,
            "penetration": s.penetration,
            "damage": s.damage,
            "module_damage": s.module_damage,
            "explosion_radius": s.explosion_radius,
        })).collect::<Vec<_>>()
    }).unwrap_or_default();

    let armor_model_val = armor_model.as_ref().map(|m| {
        let mut v = serde_json::to_value(m).unwrap_or(json!(null));
        // f32 序列化尾差清洗：62.400001525878906 → 62.4（装甲厚度精度 0.1mm 已足够；
        // 只清洗 plates/track 厚度，hull_position 等坐标保持原精度）
        if let Some(obj) = v.as_object_mut() {
            for sec in ["hull", "turret", "gun"] {
                if let Some(plates) = obj.get_mut(sec)
                    .and_then(|s| s.get_mut("plates"))
                    .and_then(|p| p.as_object_mut())
                {
                    for (_, n) in plates.iter_mut() {
                        if let Some(f) = n.as_f64() { *n = json!((f * 10.0).round() / 10.0); }
                    }
                }
            }
            if let Some(ch) = obj.get_mut("chassis").and_then(|c| c.as_object_mut()) {
                for k in ["left_track", "right_track"] {
                    if let Some(n) = ch.get_mut(k) {
                        if let Some(f) = n.as_f64() { *n = json!((f * 10.0).round() / 10.0); }
                    }
                }
            }
        }
        v
    });

    let configs = build_configs(tank_id);
    let caliber = configs.first().and_then(|c| c.get("caliber")).and_then(|v| v.as_u64()).unwrap_or(120) as u32;
    // models.pb 模型信息只解析一次，hull_spaced / 原点 / 初始炮塔旋转共用同一份
    let m_info = crate::wargaming::blitzkit::model_info(tank_id);
    let hull_spaced = m_info.as_ref().map(|m| m.hull_spaced.clone()).unwrap_or_default();
    // 模型原点（models.pb，DAVA→GLB correctZY: (x,z,y)）——装甲节点定位基准，
    // 对齐 BlitzKit SpacedArmorScene 的 hullOrigin/turretOrigin 分组装配。
    let model_origins = m_info.as_ref().and_then(|m| match (m.track_origin, m.turret_origin) {
        (Some(tk), Some(tu)) => Some(json!({
            "track": [tk[0], tk[2], tk[1]],
            "turret": [tu[0], tu[2], tu[1]],
        })),
        _ => None,
    });
    let initial_turret_rotation = m_info.as_ref().and_then(|m| m.initial_turret_rotation.clone());
    // 炮管碰撞盒（game_data/{id}.json 的 collision.gun_bbox，564/723 车有数据）。
    // 坐标系与 GLB 内部一致（x=右 y=前 z=上），原点=炮管节点（枢轴）——
    // min[1]（后伸量）= 炮闩位置的文件标定。缺失时前端回退到枢轴本身。
    let gun_collision = game_data.as_ref().and_then(|gd| gd.collision.as_ref())
        .and_then(|c| c.gun_bbox.clone())
        .map(|b| json!({ "min": b.min, "max": b.max }));
    // 各部件原生碰撞盒（坐标系 = 各部件节点枢轴系 x右/y前/z上；chassis/hull 位于模型原点）。
    // 供 DecodeShotSegment 解码盒使用。hull/turret：models.pb（BlitzKit 唯一来源，炮塔取
    // 顶级配置）；gun/chassis：BlitzKit 无对应数据，仍取本机客户端提取（game_data）。
    let mi = crate::wargaming::blitzkit::model_info(tank_id);
    let top_module = crate::wargaming::blitzkit::tank_full(tank_id)
        .and_then(|t| t.turrets.last().map(|t2| t2.module_id));
    let hull_bbox = mi.as_ref().and_then(|mi| mi.hull_bbox.clone());
    let turret_bbox = mi.as_ref().and_then(|mi| {
        mi.turrets.iter().find(|t| Some(t.module_id) == top_module)
            .or_else(|| mi.turrets.last())
            .and_then(|t| t.bbox.clone())
    });
    let gd_collision = game_data.as_ref().and_then(|gd| gd.collision.as_ref());
    let bbox_json = |b: Option<crate::wargaming::dvpl::BoundingBox>| b.map(|b| json!({ "min": b.min, "max": b.max }));
    let collision_boxes = json!({
        "chassis": bbox_json(gd_collision.and_then(|c| c.chassis_bbox.clone())),
        "hull": bbox_json(hull_bbox),
        "turret": bbox_json(turret_bbox),
        "gun": bbox_json(gd_collision.and_then(|c| c.gun_bbox.clone())),
    });

    json!({
        "tank_id": tank_id,
        "name": name,
        "tier": tier,
        "type": tank_type,
        "nation": nation,
        "model_url": format!("{}/glb/{}/collision.glb", base_prefix, tank_id),
        "visual_model_url": format!("{}/glb/{}/model.glb", base_prefix, tank_id),
        "armor": armor,
        "hull_spaced": hull_spaced,
        "model_origins": model_origins,
        "initial_turret_rotation": initial_turret_rotation,
        "gun_collision": gun_collision,
        "collision_boxes": collision_boxes,
        "armor_model": armor_model_val,
        "caliber": caliber,
        "shells": shells,
        "configs": configs.as_ref(),
        "hp": info.as_ref().and_then(|i| i.hp),
        "speed": info.as_ref().and_then(|i| i.speed_forward),
        "gun_depression": info.as_ref().and_then(|i| i.gun_depression).map(|v| v as f64),
        "gun_elevation": info.as_ref().and_then(|i| i.gun_elevation).map(|v| v as f64),
        "turret_traverse_left": info.as_ref().and_then(|i| i.turret_traverse_left).map(|v| v as f64),
        "turret_traverse_right": info.as_ref().and_then(|i| i.turret_traverse_right).map(|v| v as f64),
    })
}

fn model_config_nodes(tank_id: u32) -> (Vec<String>, Vec<String>) {
    let mut guns = Vec::new();
    let mut turrets = Vec::new();
    let path = crate::data::data_path(GLB_CACHE_DIR).join(tank_id.to_string()).join("model.glb");
    if let Ok(bytes) = std::fs::read(&path) {
        if let Some(names) = parse_glb_top_nodes(&bytes) {
            for nm in names {
                if let Some(g) = nm.strip_prefix("gun_") {
                    if g.chars().all(|c| c.is_ascii_digit()) { guns.push(nm); }
                } else if let Some(t) = nm.strip_prefix("turret_") {
                    if t.chars().all(|c| c.is_ascii_digit()) { turrets.push(nm); }
                }
            }
            guns.reverse();
            turrets.reverse();
        }
    }
    (guns, turrets)
}

fn parse_glb_top_nodes(bytes: &[u8]) -> Option<Vec<String>> {
    if bytes.len() < 20 { return None; }
    let json_len = u32::from_le_bytes(bytes[12..16].try_into().ok()?) as usize;
    if 20 + json_len > bytes.len() { return None; }
    let js: serde_json::Value = serde_json::from_slice(&bytes[20..20 + json_len]).ok()?;
    let nodes = js.get("nodes")?.as_array()?;
    let scene = js.get("scenes")?.as_array()?.first()?.get("nodes")?.as_array()?;
    let root_idx = scene.first()?;
    let root = nodes.get(root_idx.as_u64()? as usize)?;
    let children = root.get("children").and_then(|c| c.as_array())?;
    Some(children.iter()
        .filter_map(|c| nodes.get(c.as_u64()? as usize)?.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
        .collect())
}

/// GLB 下载专用 HTTP Client（进程级单例：连接池跨请求复用）。
fn glb_http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(45))
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// build_configs 进程级缓存（tank_id → 配置表）：此前每次调用都重读整个 model.glb
/// （数 MB）+ 解析 GLB JSON chunk + tank_full/model_info 深克隆——一场回放的富化
/// 循环（逐玩家/逐发调 resolve_config_index / shell_index_by_global_id）会重复
/// 60+ 次完整读盘解析。配置是 tanks.pb + models.pb + GLB 的纯函数，进程内不变。
static CONFIGS_CACHE: std::sync::OnceLock<std::sync::Mutex<HashMap<u32, Arc<Vec<Value>>>>> =
    std::sync::OnceLock::new();

pub(crate) fn build_configs(tank_id: u32) -> Arc<Vec<Value>> {
    let cache = CONFIGS_CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    if let Ok(guard) = cache.lock() {
        if let Some(c) = guard.get(&tank_id) {
            return Arc::clone(c);
        }
    }
    let configs = Arc::new(build_configs_uncached(tank_id));
    // 仅在 model.glb 已就位时入缓存：未下载的车型保持逐次重建，下载完成后
    // 下一次调用自然构建完整配置（含 gun/turret 模型节点映射）
    let glb_ready = crate::data::data_path(GLB_CACHE_DIR)
        .join(tank_id.to_string()).join("model.glb").exists();
    if glb_ready {
        if let Ok(mut guard) = cache.lock() {
            guard.insert(tank_id, Arc::clone(&configs));
        }
    }
    configs
}

fn build_configs_uncached(tank_id: u32) -> Vec<Value> {
    let Some(tank) = crate::wargaming::blitzkit::tank_full(tank_id) else { return Vec::new() };

    let (model_guns, model_turrets) = model_config_nodes(tank_id);

    let mut gun_nums: Vec<u32> = model_guns.iter()
        .filter_map(|g| g.strip_prefix("gun_")?.parse().ok()).collect();
    gun_nums.sort(); gun_nums.dedup();
    let gun_dense: std::collections::HashMap<u32, u32> =
        gun_nums.iter().enumerate().map(|(i, n)| (*n, i as u32)).collect();
    let mut turret_nums: Vec<u32> = model_turrets.iter()
        .filter_map(|g| g.strip_prefix("turret_")?.parse().ok()).collect();
    turret_nums.sort(); turret_nums.dedup();
    let turret_dense: std::collections::HashMap<u32, u32> =
        turret_nums.iter().enumerate().map(|(i, n)| (*n, i as u32)).collect();

    let tmod_info = crate::wargaming::blitzkit::model_info(tank_id);
    // 炮塔模型信息按 module_id 建索引，避免循环内对 tmod_info.turrets 反复线性查找
    let tmod_by_module: std::collections::HashMap<u32, &crate::wargaming::blitzkit::TurretModelInfo> =
        tmod_info.as_ref().map(|mi| {
            mi.turrets.iter().map(|t| (t.module_id, t)).collect()
        }).unwrap_or_default();

    let mut gun_idx_by_module: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
    let mut distinct_gun_modules = Vec::new();
    for tur in &tank.turrets {
        for gun in &tur.guns {
            if let std::collections::hash_map::Entry::Vacant(e) = gun_idx_by_module.entry(gun.module_id) {
                let idx = distinct_gun_modules.len() as u32;
                e.insert(idx);
                distinct_gun_modules.push(gun.module_id);
            }
        }
    }

    let turret_model_node = |ti: usize, tmod: u32| -> Option<u32> {
        tmod_by_module.get(&tmod).map(|t| t.model_node)
            .or_else(|| Some((ti as u32) + 1))
    };
    // (model_node, gun_thickness, gun_mask, gun_spaced)
    type GunModelInfo = (u32, Option<f32>, Option<f32>, Vec<u32>);
    let gun_model_info = |tmod: u32, gmod: u32| -> Option<GunModelInfo> {
        tmod_by_module.get(&tmod)
            .and_then(|t| t.guns.iter().find(|g| g.gun_module_id == gmod))
            .map(|g| (g.model_node, g.thickness, g.mask, g.gun_spaced.clone()))
    };

    let mut configs = Vec::new();
    let mut count = 0u32;
    for (ti, tur) in tank.turrets.iter().enumerate() {
        // 该炮塔的模型信息只查一次，供 turret_spaced / gun_origin / yaw_limits 共用
        let turret_def = tmod_by_module.get(&tur.module_id);
        let turret_name = tur.name.clone();
        let turret_weight = Some(tur.weight);
        let turret_traverse = Some(tur.traverse_speed);
        let view_range = Some(tur.view_range);
        let turret_index = turret_model_node(ti, tur.module_id)
            .and_then(|n| turret_dense.get(&n).copied())
            .unwrap_or(ti as u32);
        for gun in &tur.guns {
            let (gun_node, gun_thickness, gun_mask, gun_spaced) = gun_model_info(tur.module_id, gun.module_id)
                .unwrap_or((u32::MAX, None, None, Vec::new()));
            let gun_index = if gun_node != u32::MAX {
                gun_dense.get(&gun_node).copied()
            } else { None }
                .unwrap_or_else(|| *gun_idx_by_module.get(&gun.module_id).unwrap_or(&0));
            let turret_spaced = turret_def
                .map(|t| t.turret_spaced.clone())
                .unwrap_or_default();
            // 火炮原点（models.pb TurretModelDefinition.gun_origin，DAVA→GLB correctZY: (x,z,y)）
            let gun_origin = turret_def
                .and_then(|t| t.gun_origin)
                .map(|d| [d[0], d[2], d[1]]);
            let yaw_limits = turret_def.and_then(|t| t.yaw_limits.clone());
            let pitch_limits = turret_def
                .and_then(|t| t.guns.iter().find(|g| g.gun_module_id == gun.module_id))
                .and_then(|g| g.pitch_limits.clone());
            let name = if gun.name.is_empty() { format!("gun_{}", gun_index) } else { gun.name.clone() };
            let caliber = parse_gun_caliber(&name).map(|c| c.round() as u32).unwrap_or(120);
            let aim_time = Some(gun.aim_time);
            let dispersion = Some(gun.dispersion);
            let gr = &gun.reload;
            let reload_time = if gr.reload > 0.0 { Some(gr.reload) } else { None };
            let is_burst = gr.is_burst;
            let burst_size = gr.burst_size;
            let burst_interval = gr.burst_interval;
            let burst_reloads = gr.burst_reloads.clone();
            let is_drum = gr.is_drum;
            let shells: Vec<Value> = gun.shells.iter().map(|s| json!({
                "type": s.shell_type,
                "penetration": s.penetration,
                "penetration_far": s.penetration_far,
                "damage": s.damage,
                "module_damage": s.module_damage,
                "explosion_radius": s.explosion_radius,
                "velocity": s.velocity,
                "range": s.range,
                "caliber": s.caliber,
                "normalization": s.normalization,
                "ricochet": s.ricochet,
            })).collect();
            // 标准弹药单发伤害：优先 AP，其次任意非金币弹（金币变体 shell_type 含 premium 不计）；
            // DPM 与 Alpha 单发均基于此值
            let is_premium_shell = |t: &str| t.contains("premium");
            let standard_damage = gun.shells.iter()
                .find(|s| s.shell_type == "ap")
                .or_else(|| gun.shells.iter().find(|s| !is_premium_shell(&s.shell_type)))
                .map(|s| s.damage)
                .or_else(|| {
                    let m = gun.shells.iter().map(|s| s.damage).fold(f64::NEG_INFINITY, f64::max);
                    if m.is_finite() { Some(m) } else { None }
                })
                .unwrap_or(0.0);
            let dpm = if is_burst { None } else {
                reload_time.filter(|r| *r > 0.0).map(|r| (standard_damage * 60.0 / r).round())
            };

            configs.push(json!({
                "id": count,
                "label": name,
                "caliber": caliber,
                "shells": shells,
                "turret_index": turret_index,
                "gun_index": gun_index,
                // 模块局部 id（module_id>>8）——与 updateArena ARENA_INFO comp blob 对号，
                // 实际搭载配置解析（resolve_config_index）用
                "turret_local": (tur.module_id >> 8) as u16,
                "gun_local": (gun.module_id >> 8) as u16,
                "shell_global_ids": gun.shells.iter()
                    .filter(|s| s.id > 0)
                    .filter_map(|s| crate::replay::loadout::blitzkit_shell_global_id(&tank.nation, (s.id >> 8) as u64))
                    .collect::<Vec<u32>>(),
                "gun_thickness": gun_thickness,
                "gun_mask": gun_mask,
                "gun_spaced": gun_spaced,
                "turret_spaced": turret_spaced,
                // 火炮原点（correctZY 后的 GLB 坐标，装甲定位用，对齐 BlitzKit SpacedArmorScene）
                "gun_origin": gun_origin,
                "yaw_limits": yaw_limits,
                "pitch_limits": pitch_limits,
                "turret_name": turret_name,
                "reload_time": reload_time,
                "aim_time": aim_time,
                "dispersion": dispersion,
                "dpm": dpm,
                "standard_damage": standard_damage,
                "is_burst": is_burst,
                "is_drum": is_drum,
                "burst_size": burst_size,
                "burst_interval": burst_interval,
                "burst_reloads": burst_reloads,
                "turret_weight": turret_weight,
                "turret_traverse_speed": turret_traverse,
                "view_range": view_range,
                // 血量细分：总 HP = 车体 hp + 炮塔 health（对齐 TankResolver 口径）
                "hull_hp": tank.hp,
                "turret_health": tur.health,
                "model_gun_count": model_guns.len(),
                "model_turret_count": model_turrets.len(),
                "engines": tank.engines.clone(),
                "tracks": tank.tracks.clone(),
                "weight": tank.weight,
            }));
            count += 1;
        }
    }
    if configs.is_empty() {
        configs.push(json!({
            "id": 0, "label": "Default", "caliber": 120, "shells": [],
            "turret_index": 0, "gun_index": 0, "turret_name": "",
        }));
    }
    configs
}

/// 发射弹种 → 射手弹表下标（确定性弹种选择）：
/// 按 shell_global_ids（= tanks.pb 弹种全局 id）匹配 build_configs 各配置的弹表，
/// 返回首个包含该弹的配置中弹的下标。type=28 槽位快照存在切弹竞态（shot6 实测），
/// shell_id 才是发射弹种的权威标识。
pub fn shell_index_by_global_id(tank_id: u32, shell_id: u32) -> Option<usize> {
    if shell_id == 0 { return None; }
    build_configs(tank_id).iter().find_map(|c| {
        c["shell_global_ids"].as_array().and_then(|a| {
            a.iter().position(|s| s.as_u64() == Some(shell_id as u64))
        })
    })
}

/// 实际搭载配置解析（共享证据链，射击复现与实时回放同步使用）：
/// 证据 0 = comp blob 局部 id（updateArena ARENA_INFO，确定性：炮塔/主炮 module_id>>8 直接对号）；
/// 证据 1 = 发射弹种 ⊆ 配置弹表（shell_global_ids）；
/// 证据 2 = 初始血量 vs 车体+炮塔 health（改进耐久 ×1.125，±2 容差）；
/// 依次回退，多匹配取最后一档（顶级），全无 → None（调用方默认顶级）。
/// 返回 = (build_configs 数组下标, turret_index, gun_index)。
pub fn resolve_config_index(
    tank_id: u32,
    comp: Option<(u16, u16)>,
    shell_ids: &[u32],
    hp: u16,
) -> Option<(usize, u32, u32)> {
    let configs = build_configs(tank_id);
    if configs.len() <= 1 { return None; }
    // 证据 0：comp blob 确定性对号
    if let Some((cl, gl)) = comp {
        let exact: Vec<usize> = (0..configs.len())
            .filter(|&i| {
                configs[i]["turret_local"].as_u64() == Some(cl as u64)
                    && configs[i]["gun_local"].as_u64() == Some(gl as u64)
            })
            .collect();
        if !exact.is_empty() {
            let i = *exact.last().unwrap();
            return Some((i,
                configs[i]["turret_index"].as_u64().unwrap_or(0) as u32,
                configs[i]["gun_index"].as_u64().unwrap_or(0) as u32));
        }
    }
    let fired: std::collections::HashSet<u32> = shell_ids.iter().copied().collect();
    let gun_ok: Vec<bool> = configs.iter().map(|c| {
        fired.is_empty() || {
            match c["shell_global_ids"].as_array() {
                Some(a) if !a.is_empty() => fired.iter().all(|id| {
                    a.iter().any(|s| s.as_u64() == Some(*id as u64))
                }),
                _ => true,   // 弹表缺失（数据不全）→ 不以此排除
            }
        }
    }).collect();
    let hp_val = hp as u32;
    let hp_ok: Vec<bool> = configs.iter().map(|c| {
        if hp_val == 0 { return true; }
        let base = c["hull_hp"].as_u64().unwrap_or(0) as u32
            + c["turret_health"].as_u64().unwrap_or(0) as u32;
        if base == 0 { return true; }
        let boosted = ((base as f64) * 1.125).round() as u32;
        hp_val.abs_diff(base) <= 2 || hp_val.abs_diff(boosted) <= 2
    }).collect();
    let both: Vec<usize> = (0..configs.len()).filter(|&i| gun_ok[i] && hp_ok[i]).collect();
    let mut cands = both;
    if cands.is_empty() { cands = (0..configs.len()).filter(|&i| gun_ok[i]).collect(); }
    if cands.is_empty() { cands = (0..configs.len()).filter(|&i| hp_ok[i]).collect(); }
    let i = *cands.last()?;
    Some((i,
        configs[i]["turret_index"].as_u64().unwrap_or(0) as u32,
        configs[i]["gun_index"].as_u64().unwrap_or(0) as u32))
}

fn parse_gun_caliber(name: &str) -> Option<f64> {
    let lower = name.to_lowercase();
    let (unit_mul, idx) = if let Some(i) = lower.find(" mm") {
        (1.0, i)
    } else {
        let i = lower.find(" cm")?;
        (10.0, i)
    };
    let bytes = lower.as_bytes();
    let mut start = idx;
    while start > 0 {
        let c = bytes[start - 1];
        if c.is_ascii_digit() || c == b'.' || c == b',' {
            start -= 1;
        } else {
            break;
        }
    }
    let num = &lower[start..idx].replace(',', ".");
    num.parse::<f64>().ok().map(|v| v * unit_mul)
}

pub(crate) async fn tank_filter_handler() -> Json<Value> {
    let mut out: Vec<serde_json::Value> = crate::wargaming::blitzkit::load_tanks()
        .values().map(|t| json!({
            "id": t.tank_id,
            "name": if t.name.is_empty() { t.dev_name.clone() } else { t.name.clone() },
            "tier": t.tier,
            "nation": t.nation.clone(),
            "type": t.tank_type.clone(),
        })).collect();

    out.sort_by(|a, b| {
        a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))
    });
    Json(json!(out))
}

pub(crate) async fn shells_handler(axum::extract::Path(tank_id): axum::extract::Path<u32>) -> Json<Value> {
    let result: Value = crate::wargaming::blitzkit::tank_full(tank_id)
        .and_then(|t| t.turrets.first().and_then(|tur| tur.guns.first()).map(|g| {
            let caliber_mm = parse_gun_caliber(&g.name).map(|c| c.round() as u32).unwrap_or(120);
            let shells: Vec<Value> = g.shells.iter().map(|s| json!({
                "type": s.shell_type,
                // 全局弹种 id（与回放 shell_id 同域）：射击复现按 shell_id 反查槽位弹种用
                "global_id": crate::replay::loadout::blitzkit_shell_global_id(&t.nation, s.id as u64),
                "name": s.name,
                "penetration": s.penetration,
                "damage": s.damage,
                "module_damage": s.module_damage,
                "explosion_radius": s.explosion_radius,
            })).collect();
            json!({ "caliber": caliber_mm, "shells": shells })
        }))
        .unwrap_or(json!({ "caliber": 120, "shells": [] }));
    Json(result)
}


#[cfg(test)]
mod synth_tests {
    use super::*;

    /// 装甲模型合成迁移锚点（IS-7）：逐板厚度/履带来自 models.pb（BlitzKit 唯一来源），
    /// primaryArmor 来自 game_data 拷贝；键格式（数值字符串）与前端 plateId 查找兼容。
    #[test]
    fn synth_armor_model_migrates_to_blitzkit() {
        let am = synth_armor_model(7169).expect("IS-7 synth");
        // 车体逐板厚度：models.pb（0 值板省略）
        assert_eq!(am.hull.plates.get("1"), Some(&150.0));
        assert_eq!(am.hull.plates.get("5"), Some(&270.0));
        assert!(!am.hull.plates.contains_key("8"), "0 值板省略");
        assert_eq!(am.hull.spaced.iter().map(String::as_str).collect::<Vec<_>>(), vec!["9"]);
        // primary：game_data 同节段拷贝
        assert_eq!(am.hull.primary.front, "armor_1");
        // 炮塔/主炮（顶级配置）
        let t = am.turret.as_ref().expect("turret");
        assert_eq!(t.plates.get("2"), Some(&210.0));
        assert_eq!(t.primary.front, "armor_1");
        let g = am.gun.as_ref().expect("gun");
        assert_eq!(g.plates.get("1"), Some(&350.0));
        // 履带厚度：models.pb track
        let ch = am.chassis.as_ref().expect("chassis");
        assert_eq!(ch.left_track, 20.0);
        assert_eq!(ch.right_track, 20.0);
    }
}
