# MedMemory · 家庭医疗档案

> 一个把家人看病记录、化验单、药品、健康指标集中在本地浏览器的 PWA。
> 数据归属自己，AI 仅作为辅助解读，不做云端存储。

## 为什么做

医疗信息分散在纸质报告、医院 App、家长记忆里，真到用的时候（复诊、换医生、急诊）总是找不到。MedMemory 把这些一次性记录下来，之后任意时间任意设备都能查到。

核心设计哲学：

- **Capture First** — 看完病先拍照/口述录入"待整理"收件箱，归档留到有空时再做
- **AI First** — 化验单 OCR + 结构化、化验解读、用药指南、药品相互作用、健康趋势 — AI 当助手不替代医生
- **数据自治** — sqlite-wasm + OPFS 浏览器本地数据库，无后端，无中间商。导出 zip 可完整迁移

## 功能

| 模块 | 能做什么 |
|------|---------|
| **快速记录** | 拍照（化验单/处方/药品包装）/ 语音转文字 / 文字记录，全部进"待整理" |
| **AI 化验单处理** | GPT-4o Vision OCR + 结构化（doc_type、tags、lab_indicators、abnormal_tag）+ 异常值高亮 |
| **时间线** | 跨成员按 event_date 月分组浏览，区别于"最近录入"列表 |
| **健康问题** | 慢病 / 过敏 / 长期用药标签，AI 推荐关联到当前事件 |
| **化验解读** | 异常指标解释 + 可能病因 + 建议就诊科室（30 科室白名单 + 同义词归一化） |
| **用药指南** | 药物 overview + 剂量 + 副作用 + 与同成员其他药物相互作用（防 LLM 编造） |
| **药品包装扫描** | 拍药品包装 → AI 提取名称/用途/有效期 → 预填药品表单 |
| **药箱预警** | 即将过期 / 已过期，按月粒度判定，列表 + Dashboard 双入口 |
| **健康趋势图** | 白细胞 / 血红蛋白 / 血糖 等指标随时间变化，纯手绘 SVG 无依赖 |
| **复诊提醒** | next_visit_date 字段 + Dashboard 横幅，AI 解读时自动建议 |
| **关键词搜索** | 已 AI 处理附件的 OCR 全文 LIKE 查询 |
| **数据备份** | 一键导出 sqlite + 所有附件 Blob → zip，反之导入 |

## 技术栈

- **前端**: Vue 3 (Composition API + `<script setup>`) + TypeScript + Vite 5
- **路由/状态**: Vue Router 4 + Pinia
- **数据**: `@sqlite.org/sqlite-wasm` OPFS（持久化）+ IndexedDB（附件 Blob）
- **AI**: GPT-4o Vision (OpenAI 兼容接口，支持 ccapi.us / deepseek 等中转)
- **打包产物**: 纯静态文件，无后端服务

## 本地开发

```bash
# 装依赖
npm install

# 启动 dev server (http://localhost:5173)
npm run dev

# 类型检查
npm run typecheck

# 生产 build (产出 dist/)
npm run build

# 本地预览 build 产物
npm run preview
```

需要 COOP/COEP 头让 sqlite-wasm 启用 OPFS（vite.config.ts 已配，dev / preview 模式自动生效）。

### AI 配置

Dev 模式下 AI provider 走 Vite proxy（避免 Chromium headless 下 COEP + 系统代理叠加问题），支持 ccapi.us / deepseek 两个 host。要在 dev 模式用别的 provider，需在 `vite.config.ts` 加对应 proxy entry。

生产模式（PWA 部署后）浏览器直连，用户在设置页填 baseUrl + apiKey 即可。

## 部署（Cloudflare Pages + Git 自动部署）

### 一次性配置

1. Cloudflare dashboard → Workers & Pages → Create → Pages → **Connect to Git**
2. 授权 GitHub，选 `maoeaston/medmemory` 仓库
3. 配置:
   - **Project name**: `medmemory`（决定访问域名 `medmemory.pages.dev`）
   - **Production branch**: `main`
   - **Framework preset**: None
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
   - **Environment variables**:
     - `NODE_VERSION` = `20`（项目用 Vite 5 + vue-tsc，需 Node 18+，推荐 20）
4. Save and Deploy

首次 build 约 1-2 分钟。之后每次 `git push origin main` 自动触发部署。

### 为什么 Cloudflare Pages 能直接工作

- `public/_headers` 配 COOP/COEP 头（sqlite-wasm OPFS 硬约束）
- `public/_redirects` 配 SPA fallback（Vue Router history 模式）
- `vite.config.ts` 的 `assetFileNames` 保留 `sqlite3.wasm` 和 `sqlite3-opfs-async-proxy.js` 无 hash 文件名（sqlite-wasm worker 内部硬编码查找）

### 数据迁移（开发 → 生产）

浏览器 OPFS 是 per-origin 的，从 `localhost:5173` 换到 `medmemory.pages.dev` 不会自动迁移数据。

1. 在 dev 环境导出 zip（设置页 → 导出）
2. 部署后的 pages.dev 上传 zip 导入

## 项目结构

```
src/
├── components/         # Vue SFC 组件
│   ├── ui/             # 共享 UI 原子（EventTypeBadge / StatusBadge / ModalOverlay / ConfirmDialog）
│   ├── capture/        # 快速记录子组件（VoiceCapture / PhotoCapture / TextCapture）
│   ├── dashboard/      # Dashboard 子面板
│   ├── events/         # 事件详情子组件（AttachmentPreview / EventEditForm）
│   ├── medicines/      # 药品表单
│   ├── members/        # 成员编辑子组件
│   ├── inbox/          # 待整理归档子组件
│   ├── trends/         # 趋势图
│   └── health-agent/   # AI 化验解读/用药指南 modal
├── composables/        # Composition API hooks
├── db/                 # sqlite 连接 + migration
├── lib/                # 业务无关工具（AI provider / 医疗规则）
├── repositories/       # 数据访问层（Repository 模式）
├── router/             # Vue Router 配置
├── storage/            # IndexedDB storage adapter
├── styles/             # 全局 CSS（tokens.css + buttons.css）
└── views/              # 顶层页面（路由组件）

db/migrations/          # SQL migration 文件（按版本号顺序应用）
public/                 # 静态资源（_headers / _redirects）
docs/adr/               # 架构决策记录
```

## 数据架构

- **sqlite-wasm + OPFS**: 结构化数据（成员 / 事件 / 药品 / 化验指标 / AI 解读）。OPFS = Origin Private File System，浏览器持久化的虚拟文件系统
- **IndexedDB**: 附件 Blob（照片、录音），key 形如 `attachment/3/x.jpg`
- **导出格式**: zip 包含 `medmemory.sqlite3` + `blobs/**` + `manifest.json`（schema_version 校验）

## License

[MIT](./LICENSE) © Easton Mao
