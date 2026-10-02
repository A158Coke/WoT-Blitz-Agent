# AGENTS.md

## Release policy

`VERSION` is the single source of truth for WoT-Blitz-Agent / WASM release versions.

- Keep `VERSION` as plain SemVer `x.y.z` without a leading `v`.
- Normal feature/fix PRs must not bump `VERSION` unless that merge is intentionally meant to publish a release.
- A release-intended PR must bump `VERSION` and update the matching release entry in `docs/index.md`.
- When a `VERSION` change reaches `main`, `.github/workflows/release.yml` automatically runs tests, builds the WASM package, creates tag `v${VERSION}`, and publishes the GitHub Release.
- Do not manually create or move `v*` tags or GitHub Releases in the normal release flow.
- Released tags are immutable. Never reuse an existing version for a different commit.
- `Cargo.toml` package versions are not the product/WASM release version; do not change them just to publish a GitHub release.
- Release artifacts must be named `wotb-replay-wasm-v${VERSION}.zip`, and `fingerprint.json` must record the exact release tag and upstream commit.
- If a release job fails after tag creation, rerun the same workflow/commit instead of creating another tag.

## Parser and contract changes

- Preserve the repository's fail-closed behavior for ambiguous replay evidence; do not guess protocol semantics from a single sample.
- Public replay/facet contract changes must be documented together with the implementation.
- WotbTools consumes this repository as the upstream replay parser. Parser fixes belong here first, then WotbTools updates its pinned Agent release.
