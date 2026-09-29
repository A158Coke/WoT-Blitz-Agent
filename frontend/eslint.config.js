// ESLint 平面配置：场景 JS（~5500 行手写 three.js）的回归网——
// no-undef 恰好拦截"使用未导入标识符"类运行时才炸的错误（如 replaySource.js
// 曾漏 import assetUrl 导致全画质档地图不加载，见架构债文档）。
// .vue 组件暂不入 lint 面（引入 eslint-plugin-vue 后扩展）。
import js from '@eslint/js'
import globals from 'globals'

export default [
  { ignores: ['dist/**', 'public/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
  },
  {
    // 场景内核：GLB/贴图加载失败的静默兜底是既定模式（空 catch/空 rejection
    // handler），no-empty 降级；拆分 viewer/ 目录时再逐处收敛
    files: ['src/scene/**'],
    rules: {
      'no-empty': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
]
