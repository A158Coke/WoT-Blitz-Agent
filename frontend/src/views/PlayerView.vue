<script setup>
// Player Stats：WG API 玩家战绩查询（随机战 / 排位战）。
import { ref } from 'vue'
import { playerSearch } from '../api/stats.js'
import { fmtInt, wrCls } from '../utils/format.js'
import { useToast } from '../composables/useToast.js'

const { toast } = useToast()
const nick = ref('')
const loading = ref(false)
const notFound = ref(false)
const player = ref(null)

// 单个战绩统计块（随机战 / 排位战共用）
function block(p, pre) {
  const b = p[pre + 'battles'] || 0
  if (!b) return null
  const wr = 100 * p[pre + 'wins'] / b
  return {
    title: pre === 'random_' ? 'Random 随机战' : 'Rating 排位战',
    battles: fmtInt(b),
    wr,
    dmg: fmtInt(p[pre + 'damage_dealt'] / b),
    frags: (p[pre + 'frags'] / b).toFixed(2),
    hit: (p[pre + 'shots'] && p[pre + 'hits'] != null) ? 100 * p[pre + 'hits'] / p[pre + 'shots'] : null,
    xp: p[pre + 'xp'] ? p[pre + 'xp'] / b : null,
    spotted: (p[pre + 'spotted'] != null && b) ? p[pre + 'spotted'] / b : null,
  }
}

async function search() {
  const name = nick.value.trim()
  if (!name) { toast('Enter a nickname'); return }
  loading.value = true
  notFound.value = false
  player.value = null
  try {
    const d = await playerSearch(name)
    if (!d.players || !d.players.length) { notFound.value = true; return }
    player.value = d.players[0]
  } catch (e) {
    toast('查询失败: ' + (e.message || e))
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <section class="tab-view">
    <div class="card">
      <h2>Player Stats</h2>
      <div class="sub">WG API 玩家战绩查询</div>
      <div class="row">
        <input v-model="nick" placeholder="Nickname (e.g. Anonyme)" @keydown.enter="search">
        <button class="btn btn-primary" @click="search">Search</button>
      </div>
      <div v-if="loading" class="muted"><span class="spinner"></span></div>
      <div v-else-if="notFound" class="muted">No player found.</div>
      <template v-else-if="player">
        <h3 style="margin:14px 0 6px;">{{ player.nickname }}</h3>
        <div
          v-if="player.rating_mm_rating != null || player.rating_display_rating != null"
          class="muted" style="margin:2px 0 10px;"
        >
          MM Rating: <b style="color:var(--accent-2);">{{ player.rating_mm_rating != null ? Number(player.rating_mm_rating).toFixed(1) : '-' }}</b><template v-if="player.rating_display_rating != null"> · 显示评级 <b style="color:var(--accent-2);">{{ player.rating_display_rating }}</b></template><template v-if="player.rating_season != null"> · 赛季 {{ player.rating_season }}</template>
        </div>
        <div v-for="b in [block(player, 'random_'), block(player, 'rating_')].filter(Boolean)" :key="b.title" class="card" style="padding:16px 18px;margin-bottom:14px;">
          <h4 style="margin:0 0 8px 0;">{{ b.title }} <span class="muted" style="text-transform:none;letter-spacing:0;">{{ b.battles }} 场</span></h4>
          <div class="stat-grid" style="grid-template-columns:repeat(auto-fill,minmax(120px,1fr));margin:0;">
            <div class="stat-box"><div class="lbl">Win rate</div><div class="val" :class="wrCls(b.wr)">{{ b.wr.toFixed(1) }}%</div></div>
            <div class="stat-box"><div class="lbl">Avg dmg</div><div class="val b">{{ b.dmg }}</div></div>
            <div class="stat-box"><div class="lbl">Avg frags</div><div class="val">{{ b.frags }}</div></div>
            <div v-if="b.hit != null" class="stat-box"><div class="lbl">Hit rate</div><div class="val o">{{ b.hit.toFixed(1) }}%</div></div>
            <div v-if="b.xp != null" class="stat-box"><div class="lbl">Avg XP</div><div class="val">{{ fmtInt(b.xp) }}</div></div>
            <div v-if="b.spotted != null" class="stat-box"><div class="lbl">Avg spotted</div><div class="val">{{ b.spotted.toFixed(2) }}</div></div>
          </div>
        </div>
        <div v-if="!block(player, 'random_') && !block(player, 'rating_')" class="card" style="padding:14px 18px;">
          <h4 style="margin:0;">无战绩</h4>
        </div>
      </template>
    </div>
  </section>
</template>
