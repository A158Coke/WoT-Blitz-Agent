//! 真实样本冒烟：客户端路径（无 resolver/俯仰锚定/地图注册表）产出三切面并满足基本不变量。
//! 样本取 data/replay_samples 最大的 .wotbreplay（整场对战）；无样本环境跳过。

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

#[test]
fn client_path_facets_smoke() {
    let Some(path) = largest_sample() else {
        eprintln!("无回放样本，跳过");
        return;
    };
    eprintln!("样本: {}", path.display());
    let bytes = std::fs::read(&path).unwrap();

    let f = wotb_replay_wasm::build_facets(&bytes).expect("客户端路径构建成功");

    let hof: serde_json::Value = serde_json::from_str(&f.hof).unwrap();
    assert_eq!(hof["version"], 1);
    let entries = hof["entries"].as_array().unwrap().len();
    assert!((8..=28).contains(&entries), "名人堂行数 {entries}");

    let ai: serde_json::Value = serde_json::from_str(&f.ai).unwrap();
    assert_eq!(ai["version"], 1);
    let rosters = ai["rosters"].as_array().unwrap().len();
    assert!((10..=28).contains(&rosters), "花名册 {rosters}");
    // 客户端路径已知边界如实透出：时长未知 = null，绝不 0/0.0
    assert!(ai["battle"]["duration_secs"].is_null(), "结算时长未知必须 null");

    let pb: serde_json::Value = serde_json::from_str(&f.playback).unwrap();
    assert_eq!(pb["version"], 1);
    let nv = pb["vehicles"].as_array().unwrap().len();
    assert!((8..=28).contains(&nv), "车辆数 {nv}");
    assert!(pb["meta"]["samples"].as_u64().unwrap() > 600, "整场网格过短");

    // 信封：playback/ai/hof 三键齐且为对象
    let env: serde_json::Value = serde_json::from_str(&f.envelope_json().unwrap()).unwrap();
    for k in ["playback", "ai", "hof"] {
        assert!(env[k].is_object(), "信封缺 {k}");
    }
}
