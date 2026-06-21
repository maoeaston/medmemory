import { createApp } from 'vue'
import App from './App.vue'
import { wirePocToWindow } from '@/db/poc'

// dev 模式下挂载 PoC 到 window.medmemoryPoc, 供 console 验证 sqlite-wasm+OPFS.
// build 模式 wirePocToWindow 内部早退, 不污染生产 bundle.
wirePocToWindow()

createApp(App).mount('#app')
