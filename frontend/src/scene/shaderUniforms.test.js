import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 着色器 uniform 声明完整性守卫。
 *
 * 起因是一次真实故障：叶卡 billboard 材质在 JS 的 `uniforms` 里给了 `uAlphaCut`，
 * 片段着色器也用了 `if (c.a < uAlphaCut) discard;`，但**着色器里从未声明
 * `uniform float uAlphaCut;`**。结果该程序编译失败（GLSL 的 uniform 必须显式声明，
 * JS 传值不会引入符号），three 静默跳过这些网格——全场 606 个叶片/灌木卡片
 * 一个像素都不渲染，而树干等静态网格照常显示，从画面上看就是"树没有叶子、
 * 灌木消失"。这类失败在 JS 侧完全不报错，只在 WebGL 程序诊断里可见，
 * 所以用一条静态断言把它锁住。
 *
 * 只覆盖 playbackScene.js：该文件的着色器是内联模板串，可静态提取；
 * tankViewer.js 的着色器是外部常量（PBR_VERT 等），不在此守卫范围内。
 */
const SRC = readFileSync(new URL('./playbackScene.js', import.meta.url), 'utf8')

/** 从 text[start]（须为 '{'）起做括号配对，返回最外层花括号内部文本 */
function sliceBraces(text, start) {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start + 1, i)
    }
  }
  throw new Error(`花括号不配对（偏移 ${start}）`)
}

/** 切出每个 `new THREE.ShaderMaterial({...})` 的构造对象体 + 其行号 */
function shaderBlocks(src) {
  const marker = 'new THREE.ShaderMaterial({'
  const out = []
  for (let from = 0; ;) {
    const i = src.indexOf(marker, from)
    if (i === -1) break
    out.push({
      line: src.slice(0, i).split('\n').length,
      body: sliceBraces(src, i + marker.length - 1),
    })
    from = i + marker.length
  }
  return out
}

const blocks = shaderBlocks(SRC)

describe('场景着色器 · uniform 声明完整性', () => {
  // 结构性兜底：提取逻辑一旦失效（例如改成外部常量），本测试必须失败而不是空转通过
  it('能定位到本文件全部的 ShaderMaterial', () => {
    expect(blocks.length).toBe(2)
  })

  it('JS uniforms 里给了、且着色器里真的用到的名字，都必须有 uniform 声明', () => {
    const problems = []
    for (const { line, body } of blocks) {
      const uIdx = body.indexOf('uniforms:')
      expect(uIdx, `L${line} 附近找不到 uniforms 块`).toBeGreaterThan(-1)
      const uniformsText = sliceBraces(body, body.indexOf('{', uIdx))
      const names = [...uniformsText.matchAll(/(\w+)\s*:\s*\{\s*value/g)].map((m) => m[1])
      expect(names.length, `L${line} 未解析出任何 uniform 名`).toBeGreaterThan(0)

      const shaderSrc = [...body.matchAll(/(?:vertexShader|fragmentShader):\s*`([^`]*)`/g)]
        .map((m) => m[1]).join('\n')
      expect(shaderSrc.length, `L${line} 未取到着色器源码`).toBeGreaterThan(0)
      const declared = new Set(
        // 允许数组 uniform（如 `uniform vec3 uTC[4];`）——下标后缀要吃掉，
        // 否则会被误判成"未声明"
        [...shaderSrc.matchAll(/uniform\s+\w+\s+(\w+)\s*(?:\[[^\]]*\])?\s*;/g)].map((m) => m[1]))

      for (const name of names) {
        const used = new RegExp(`\\b${name}\\b`).test(shaderSrc)
        if (used && !declared.has(name)) {
          problems.push(`L${line}: uniform "${name}" 在着色器中被使用，但没有 uniform 声明`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('叶卡材质的裁切阈值 uAlphaCut 已声明（本次故障的直接回归）', () => {
    const card = blocks.find((b) => b.body.includes('_corner'))
    expect(card, '找不到叶卡 billboard 材质').toBeTruthy()
    expect(card.body).toMatch(/uniform\s+float\s+uAlphaCut\s*;/)
  })
})
