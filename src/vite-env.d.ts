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
