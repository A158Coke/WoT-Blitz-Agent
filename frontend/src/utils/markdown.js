// Markdown + LaTeX 渲染管线：llm 回复常含 markdown/LaTeX 标记，转成可见富文本。
// markdown-it（html:false 禁内联 HTML）→ KaTeX 行内/块级公式 → DOMPurify 消毒。
import markdownit from 'markdown-it'
import DOMPurify from 'dompurify'
import 'katex/dist/katex.min.css' // 连同字体一并打包，替代旧版 /api/vendor/katex 离线文件
import renderMathInElement from 'katex/contrib/auto-render'

const parser = markdownit({ html: false, linkify: true, breaks: true })

export function renderMarkdown(text) {
  const src = (text || '').toString()
  let html = parser.render(src)
  try {
    const div = document.createElement('div')
    div.innerHTML = html
    renderMathInElement(div, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false },
      ],
      throwOnError: false,
    })
    html = div.innerHTML
  } catch { /* 渲染失败则保留原始 html，不抛错 */ }
  return DOMPurify.sanitize(html)
}
