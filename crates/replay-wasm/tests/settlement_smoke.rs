//! 结算通道冒烟：真实样本 → settlement_json → BattleSummary JSON 不变量。
//! 样本取 data/replay_samples 任一 .wotbreplay；无样本环境跳过。

use std::path::PathBuf;

fn any_sample() -> Option<PathBuf> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../data/replay_samples");
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "wotbreplay").unwrap_or(false))
        .max_by_key(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0))
}

#[test]
fn settlement_smoke() {
    let Some(path) = any_sample() else {
        eprintln!("无回放样本，跳过");
        return;
    };
    eprintln!("样本: {}", path.display());
    let bytes = std::fs::read(&path).unwrap();

    let t0 = std::time::Instant::now();
    let json = wotb_replay_wasm::settlement_json(&bytes).expect("结算解析成功");
    eprintln!("解析耗时: {:?}", t0.elapsed());

    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert!(v["players"].is_array(), "players 必须是数组");
    let n = v["players"].as_array().unwrap().len();
    assert!(n >= 8, "战斗者数异常: {n}");
    assert!(v["datetime"].is_string(), "datetime 必须存在");
    assert!(v["map_id"].is_u64(), "map_id 必须存在");

}
