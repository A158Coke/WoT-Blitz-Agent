//! 真实样本冒烟（契约 v2 能力边界）：客户端路径（无 resolver/俯仰锚定/地图注册表）
//! 产出的独立能力满足基本不变量。样本取 data/replay_samples 最大的 .wotbreplay
//!（整场对战）；无样本环境跳过。
//!
//! 评审验收对映：
//! 1. Result-only parse 不物化 Playback、不依赖 HoF facet —— `result_smoke`：
//!    输出无 vehicles/时序键、体积比 Playback 小两个量级；
//! 2. Agent 公开面无 HoF —— 编译级保证（`HofFacet` 已删除，giant envelope 已拆除）。

use std::path::PathBuf;

fn largest_sample() -> Option<PathBuf> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../data/replay_samples");
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "wotbreplay").unwrap_or(false))
        .max_by_key(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0))
}

/// 结果能力：BattleSummary 齐备，且**不含**时序物化（毫秒级通道的边界不变量）。
#[test]
fn result_smoke() {
    let Some(path) = largest_sample() else {
        eprintln!("无回放样本，跳过");
        return;
    };
    eprintln!("样本: {}", path.display());
    let bytes = std::fs::read(&path).unwrap();

    let result: serde_json::Value =
        serde_json::from_str(&wotb_replay_wasm::result_json(&bytes).expect("结果能力构建成功"))
            .unwrap();
    let players = result["players"].as_array().unwrap().len();
    assert!((8..=28).contains(&players), "花名册 {players}");
    assert!(result["author_account_id"].as_u64().unwrap() > 0, "作者在册");
    assert!(result["winner_team"].as_u64().map(|w| w == 1 || w == 2).unwrap_or(false));
    // 时序物化键不得出现在结果通道（PlaybackData 专属键）
    for key in ["vehicles", "shots", "kills", "periods", "visibility"] {
        assert!(result.get(key).is_none(), "结果能力不得物化时序键 {key}");
    }
}

/// 时序能力：PlaybackData 齐备；体积与结果通道的量级差证明两者独立（非信封捆绑）。
#[test]
fn playback_smoke() {
    let Some(path) = largest_sample() else {
        eprintln!("无回放样本，跳过");
        return;
    };
    let bytes = std::fs::read(&path).unwrap();

    let playback_str = wotb_replay_wasm::playback_json(&bytes).expect("时序能力构建成功");
    let pb: serde_json::Value = serde_json::from_str(&playback_str).unwrap();
    assert_eq!(pb["version"], 2, "contract v2（版本门禁；消费端拒绝错版）");
    // contract v2 新键：非争霸场为空数组也必须安全序列化在场（skip_serializing_if 语义）
    for key in ["supremacy_bases", "supremacy_points", "aim_frames"] {
        assert!(pb.get(key).is_none_or(|v| v.is_array()), "v2 键 {key} 须为数组或缺省");
    }
    let nv = pb["vehicles"].as_array().unwrap().len();
    assert!((8..=28).contains(&nv), "车辆数 {nv}");
    assert!(pb["meta"]["samples"].as_u64().unwrap() > 600, "整场网格过短");

    // 结果通道（毫秒级）输出体积必须比全场时序小两个量级——Result-only 消费
    // 不被迫物化 ~MB 级 Playback（契约 v2 拆分动机）
    let result_str = wotb_replay_wasm::result_json(&bytes).unwrap();
    assert!(
        result_str.len() * 100 < playback_str.len(),
        "result {}B vs playback {}B——量级分离失效",
        result_str.len(),
        playback_str.len()
    );
}

/// 跨 facet 身份不变量：Playback 中每个有昵称的 observed vehicle 必须能在
/// Result 花名册找到同名玩家，且 account_id/team/tank_id 完全一致（Result 为
/// oracle——昵称联表 SSOT 在模型 scan 一次完成；ASCII 过滤时代中文昵称车辆
/// team=0 且无身份，本测试即回归锚）。不做全局车辆数断言：single-POV/AoI 下
/// 整场未观察到的敌人合法缺席。
#[test]
fn playback_result_identity_invariant() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../data/replay_samples");
    let Some(rd) = std::fs::read_dir(&dir).ok() else { return };
    let mut checked = 0;
    for path in rd.flatten().map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "wotbreplay").unwrap_or(false))
    {
        let bytes = std::fs::read(&path).unwrap();
        let Ok(result_str) = wotb_replay_wasm::result_json(&bytes) else { continue };
        let Ok(playback_str) = wotb_replay_wasm::playback_json(&bytes) else {
            eprintln!("跳过（非整场/片段）: {}", path.display());
            continue;
        };
        let result: serde_json::Value = serde_json::from_str(&result_str).unwrap();
        let pb: serde_json::Value = serde_json::from_str(&playback_str).unwrap();

        let roster: std::collections::HashMap<&str, &serde_json::Value> = result["players"]
            .as_array().unwrap().iter()
            .map(|p| (p["nickname"].as_str().unwrap_or(""), p))
            .collect();
        let mut named = 0;
        for v in pb["vehicles"].as_array().unwrap() {
            let Some(nick) = v["nickname"].as_str().filter(|s| !s.is_empty()) else { continue };
            let player = roster.get(nick)
                .unwrap_or_else(|| panic!("{}: observed 昵称 {nick:?} 不在 Result 花名册", path.display()));
            assert_eq!(v["account_id"], player["account_id"], "{nick} account_id 联表一致");
            assert_eq!(v["team"], player["team"], "{nick} team 联表一致");
            assert_eq!(v["tank_id"], player["tank_id"], "{nick} tank_id 联表一致");
            assert!(v["team"].as_u64().unwrap() == 1 || v["team"].as_u64().unwrap() == 2,
                "{nick} team 必须是 1/2（联表成功），不得为 0");
            named += 1;
        }
        eprintln!("--- {}: {} 车全部通过（具名 {named}）", path.display(), pb["vehicles"].as_array().unwrap().len());
        checked += 1;
    }
    assert!(checked > 0, "至少一个可解析样本");
}

/// 射击复现通道：弹种反解注入不变量——`shells_json`（dump-shell-kinds 富表）
/// 注入后带 shell_id 的弹全部补齐 `shell_kind` 与 `shell`（type/穿深一致）；
/// 缺省表时 shell_kind 为空串、无 shell 字段（数据可得性边界）。
#[test]
fn shot_replays_shell_injection_smoke() {
    // 样本须含已知全局弹种 id 的对局：GB13_FV215b 场（作者/他人均发 18010 APCR）
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../data/replay_samples");
    let path = std::fs::read_dir(&dir).ok()
        .and_then(|rd| rd.flatten().map(|e| e.path())
            .find(|p| p.file_name().map(|n| n.to_string_lossy().contains("FV215b")).unwrap_or(false)));
    let Some(path) = path else {
        eprintln!("无 FV215b 样本，跳过");
        return;
    };
    let bytes = std::fs::read(&path).unwrap();

    // 表来源与 dump-shell-kinds 同形状（现取 tanks.pb 全量展开；wasm 测试环境
    // 无 CLI，直接用上游 annotate 同款构建入口——src 侧 ShellKindTable 不可达，
    // 此处以最小内联表覆盖断言即可，全域覆盖由 dump CLI 产物保证）
    let bare: serde_json::Value =
        serde_json::from_str(&wotb_replay_wasm::shot_replays_json(&bytes, None, None).unwrap()).unwrap();
    // 契约 v0.1.9：包装对象 + fail-visible 诊断（作者严格路径健康时无 author_error）
    let shots = bare["shots"].as_array().expect("shots 数组");
    assert_eq!(bare["author_path"], "ok", "健康样本作者路径应 ok");
    assert!(bare.get("author_error").is_none(), "ok 态不得携带 author_error");
    assert!(bare["author_eid"].as_u64().unwrap_or(0) > 0, "作者 eid 已解析");
    assert!(bare["others"]["total_launches"].is_u64(), "他人路径统计在场");
    assert!(!shots.is_empty(), "样本应含射击事件");
    for s in shots {
        assert!(s.get("shell").is_none(), "缺省表不得输出 shell 字段");
        if s["shell_id"].as_u64().unwrap_or(0) > 0 {
            assert_eq!(s["shell_kind"].as_str().unwrap_or(""), "", "缺省表 kind 恒空");
        }
    }

    // 内联最小富表（FV215b APCR = 0x465a = 18010；样本含该弹——GB13_FV215b 场）
    let table = r#"{"18010":{"type":"ap_cr_premium","penetration":326,"damage":340,"module_damage":165,"explosion_radius":0}}"#;
    let injected: serde_json::Value =
        serde_json::from_str(&wotb_replay_wasm::shot_replays_json(&bytes, None, Some(table)).unwrap()).unwrap();
    let mut resolved = 0;
    for s in injected["shots"].as_array().unwrap() {
        if s["shell_id"].as_u64() != Some(18010) { continue; }
        resolved += 1;
        assert_eq!(s["shell_kind"], "ap_cr_premium", "kind 反解");
        assert_eq!(s["shell"]["penetration"], 326, "穿深注入");
        assert_eq!(s["shell"]["damage"], 340, "伤害注入");
    }
    assert!(resolved > 0, "样本应含 18010 弹（表注入生效的先验）");
}
