import './styles/tokens.css'
import './styles/buttons.css'
import './styles/transitions.css'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from '@/router'
import { wirePocToWindow } from '@/db/poc'
import { wireRepoPocToWindow } from '@/repositories/poc'

// dev 模式下挂载 PoC 到 window, 供 console 验证:
//   - window.medmemoryPoc.runPoc()                       基础设施层 (sqlite-wasm + OPFS)
//   - window.medmemoryRepoPoc.runRepositorySmokeTest()    Repository 层 (8 表 + Search)
// build 模式下 wire*ToWindow 内部早退, 不污染生产 bundle.
wirePocToWindow()
wireRepoPocToWindow()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
