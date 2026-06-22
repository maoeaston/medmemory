/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

// Vite ?raw 后缀导入：以字符串形式返回文件原始内容
// 用于 db/migrations/*.sql 的编译期内联（避免运行时 fetch）
declare module '*?raw' {
  const content: string
  export default content
}

// 项目自定义环境变量（通过 import.meta.env 访问）
// 修改前先看 vite.config + .env.example 约定
interface ImportMetaEnv {
  /**
   * OpenAI API key, 作为默认值（用户在 Settings 页输入的 key 会优先）。
   * 仅用于开发便利, 生产环境推荐让用户在 Settings 页填写。
   * 注意: Vite 会把 VITE_ 前缀变量打进 bundle, 本质明文, 自用场景已接受。
   */
  readonly VITE_OPENAI_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
