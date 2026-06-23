# 同步设计评审 (Phase 2)

> 评审日期: 2026-06-23
> 评审对象: `docs/sync-design.md` draft-v1
> 评审人: AI 顾问

---

## 严重问题 (阻塞实施)

### S1. checkin 写 snapshot.zip 与 version.txt 非原子 — 崩溃后 version 与 snapshot 不一致

**现状**: §2.4 step 5 写 `snapshot.zip` (tmp → rename), step 6 写 `version.txt` (write tmp → rename)。如果 step 5 完成后、step 6 完成前进程崩溃或断电:
- snapshot.zip 已经是新版本 N 的内容
- version.txt 还停在旧版本 N-1
- 重启后, 下一个 checkout 拿到的是 v=N-1 对应的响应头, 但实际 zip 内容是 v=N
- 如果此时新数据有问题需要回溯, 无法通过 version 判断

**影响**: version 语义不可靠。虽然概率极低 (单进程 Node.js, step 5 和 step 6 之间只有几毫秒), 但一旦发生, version 与快照内容脱节, 后续乐观锁机制失效。

**建议修改**: §2.4 调整写入顺序: 先写 version.txt (tmp → rename), 再写 snapshot.zip (tmp → rename)。这样如果崩溃:
- version.txt 已更新但 snapshot.zip 没更新 → 下一个 checkout 拿到新 version 但旧 snapshot。version 校验仍然一致 (新 checkout 基于 version.txt 的值, snapshot 是旧的但 version 匹配), 不影响正确性。后续 checkin 会用新 version 校验, 逻辑正确。
- 反过来 (当前设计): snapshot 新但 version 旧 → version 校验逻辑混乱。

更深层问题: 即使调整顺序, 也不是真正原子的。根本解法是把 version 直接嵌入 snapshot.zip 的 manifest.json 内, 校验时同时检查 version.txt 和 manifest 内的 version 一致性。但这对 2 人家庭场景过度设计。

**最终建议**: 调整顺序为先 version 后 snapshot, 在文档中明确记录这个取舍。

### S2. importAllData 中途失败导致本地数据永久丢失

**现状**: §4.2 checkout 流程第 5 步调 `importAllData(zipBlob)`。看代码 (useDataBackup.ts L241-256):
1. `closeDb()` — 关闭 sqlite 连接
2. 覆写 OPFS 的 `medmemory.sqlite3` 文件
3. 清理 orphan blob
4. 写入新 blob

如果步骤 2 (覆写 sqlite 文件) 成功但步骤 3-4 (写 blob) 失败 (如浏览器崩溃、内存不足), 结果是:
- sqlite 已经是新数据 (包含 blob storage_key 引用)
- 但 IDB 里的 blob 是旧数据 + 被清了一部分 orphan
- sqlite 引用的 blob 在 IDB 里不存在 → 附件永久丢失

**影响**: checkout 过程中断 = 本地数据不一致。sqlite 说有附件, 但 IDB 没有。这不是服务器端的问题, 是客户端 importAllData 的固有风险, 但同步场景放大了这个风险 (每次 checkout 都会调 importAllData 覆写本地)。

**建议修改**:
1. checkout 前先自动调 `exportAllData()` 导出一份本地 zip 存到 `localStorage` 的一个临时 key (或触发浏览器下载)。如果 checkout 后用户发现数据丢失, 可以从这份备份恢复。
2. 文档 §4.2 增加一步: checkout → 先 exportAllData 存为 localBackupBlob (内存或 OPFS 备份目录) → 再 importAllData (服务器 zip) → 验证成功后删除 localBackupBlob。
3. 或者更简单: checkout 前如果本地有数据, 弹确认 "拉取服务器数据将覆盖本地, 建议先导出备份"。

### S3. 锁强制释放后原持有者 checkin 不被 version 校验阻挡 — 数据覆盖

**现状**: §5 冲突场景 #2 描述了 version 冲突的处理, 但有一个漏洞:

```
T0: A checkout (v=7), 获锁
T1: B 强制释放锁 (DELETE /lock, force=true)
T2: B checkout (v=7), 获锁
T3: B 编辑 + checkin (v=8), 释放锁
T4: A 不知情, 继续编辑, 发 checkin (v=7)
```

T4 时, A 的 clientId 不再是锁主 (锁已被释放或被 B 持有)。服务端 checkin step 2 校验锁状态, 发现 clientId 不匹配 → 返回 `403 NOT_LOCK_HOLDER`。

但是再看另一个路径:
```
T0: A checkout (v=7), 获锁
T1: B 强制释放锁
T2: B checkout (v=7), 获锁
T3: A 网络恢复, heartbeat 成功 (如果锁 TTL 还没到, 但锁已经被 B 拿了)
```

T3 时 A 的 heartbeat 会被 `403 NOT_LOCK_HOLDER` 拒绝。这没问题。

但真正危险的场景:
```
T0: A checkout (v=7), 获锁
T1: A 网络断开
T2: A 的锁 TTL 过期 (30min)
T3: B checkout (v=7), 获锁
T4: B 编辑 + checkin (v=8), 释放锁
T5: A 网络恢复, 检查 state → 发现锁已释放 (lockedBy=null, version=8)
T6: A 直接调 checkin (v=7) — 不经过 checkout
```

T6 时 checkin 校验: clientId 不匹配 (锁空闲) → 403。**正确, 挡住了。**

再想一个: A checkout 后 server 重启, lock.json 中 A 的锁状态还在 (未过期):
- A 继续编辑, 发 checkin (v=7)
- server 从 lock.json 恢复, clientId 匹配, version 匹配 → 200。**正确。**

结论: 当前设计在正常路径下 version 校验 + clientId 校验能挡住大部分情况。但 **force-release 不更新 version**, 如果 force-release 后没人 checkout, 锁空闲但 version 还是旧的, A 发 checkin 时 version 匹配 + clientId 校验... 等等, A 的 clientId 此时不匹配 (锁已释放)。

**实际严重程度重新评估**: clientId 校验 + version 校验的双重保护在大多数场景下有效。但有一个真实漏洞:

```
T0: A checkout (v=7), 获锁, 锁状态 lockHolder=A
T1: A 的 heartbeat 因网络问题失败, 但 A 没有察觉 (客户端没正确处理 heartbeat 失败)
T2: A 的锁 TTL 过期, 服务器标记为 expired
T3: B checkout (v=7), 获锁 (服务器惰性清理过期锁)
T4: A 的网络恢复了, A 的 syncState 还是 'editing' (heartbeat 失败没有触发状态转换)
T5: B checkin (v=8)
T6: A 发 checkin (v=7) → clientId 不匹配 → 403
```

这个场景被挡住了。但客户端行为:
- A 收到 403 后 syncState → 'error', 本地数据卡住
- 需要用户手动处理 (导出备份或拉取最新覆盖)

**这个 UX 是可接受的**。version 冲突的处理流程 (§5.1) 已经覆盖。

**最终评估**: 将此问题从严重降为中等。clientId + version 双重校验在服务端是有效的。问题在于客户端 heartbeat 失败后没有及时退出 editing 状态 (见 M2)。

### S4. beforeunload auto-checkin + fetch keepalive 64KB 限制 — UX 矛盾 (需明确结论)

**现状**: §4.4 / §10.4 描述了 auto-checkin 策略:
- beforeunload 时尝试 `fetch(url, { keepalive: true })`
- 但 keepalive 限制 64KB body
- 典型 zip (sqlite + blob) 可能几十 MB
- 文档承认"大概率被截断", 但仍然保留了 auto-checkin 代码路径

**问题**:
1. 如果 zip 被截断, 服务端收到的是损坏的 multipart body, multer 解析可能:
   - 解析失败 → 返回 400 → 但页面已经卸载, 客户端收不到错误
   - 解析"成功"但 zip 不完整 → 写入损坏 snapshot.zip → **数据丢失**
2. 用户看到 beforeunload 提示, 以为数据会自动保存, 实际没有
3. 即使 64KB 以内的请求成功了, 服务端需要正确处理 keepalive 请求的认证 (X-Sync-Token 在 header 里, 这个没问题)

**明确结论**: **放弃 beforeunload auto-checkin**。理由:
- zip 几乎不可能 < 64KB (sqlite + manifest 已经超了)
- 截断的风险是损坏服务器快照, 比不做 auto-checkin 更糟
- 正确策略: beforeunload 只做提示 (弹原生对话框), 不做任何网络请求

**替代方案 (选定的)**:
1. beforeunload 只弹原生对话框提示用户 (不做 fetch)
2. 如果用户在编辑, 进入 editing 状态后每 5 分钟自动调 `exportAllData()` 在内存中保留一份 latestAutoExport Blob (不做 IO, 不影响用户)
3. 用户下次打开时, initOnAppStart 发现自己仍持锁 → 恢复 editing 状态, 本地数据完好
4. TTL 30 分钟兜底: 即使浏览器崩溃, 锁自动释放, 数据在本地不丢 (OPFS + IDB 持久化)
5. TTL 保持 30 分钟不变 (理由见 M1)

---

## 中等问题 (应该修复, 不阻塞)

### M1. TTL 30 分钟 + heartbeat 10 分钟的取舍评估

**现状**: §3.1 设定 TTL=30min, heartbeat=10min。

**分析**:
- 30 分钟 TTL 在浏览器崩溃场景下, 另一人要等 30 分钟才能编辑。家庭医疗场景, 这个等待是可接受的不便, 不是灾难。
- 缩短到 15 分钟: heartbeat 需要提到 5 分钟, 网络不好时更容易丢锁
- 缩短到 10 分钟: 几乎要求用户持续在线, 稍微进个电梯就丢锁

**结论**: 30 分钟 TTL 是合理取舍, 保持不变。但增加一个改进: heartbeat 连续失败后提前通知用户 (当前设计已有, §10.2 的 5 分钟提醒), 让用户有足够时间手动 checkin 或导出。

### M2. heartbeat 失败后客户端不及时退出 editing 状态

**现状**: §9.5 heartbeat 连续 3 次失败 → syncState = 'error'。但在失败期间, syncState 仍是 'editing', 用户继续编辑却不知道锁可能已经丢了。

**问题**: 如果 heartbeat 因为网络中断连续失败 3 次 (30 分钟内), 期间锁可能已过期被别人取走。用户继续编辑, 最终 checkin 被拒。

**建议**: heartbeat 失败 1 次后立即弹非阻塞 toast "网络异常, 编辑锁可能丢失"。连续 2 次失败后 syncState → 'error' (不等 3 次), 让用户尽早知道。

### M3. 首次同步场景 B (双向有数据) 缺少二次确认

**现状**: §10.3 场景 B, 用户选择 "上传本地覆盖服务器" 后直接执行。如果点错, 服务器数据丢失。

**建议**: 选择任一覆盖选项后, 弹二次确认对话框: "确定要用本地数据覆盖服务器版本 7? 此操作不可撤销。" 二次确认后执行。

### M4. Caddy 层去留未做明确决策

**现状**: §6.7.3 给了去掉 Caddy 的方案但标注 "Phase 2 评审时定", 没有拍板。

**分析**:
- 当前架构 `浏览器 → Nginx :443 → Caddy :8080 → 静态文件` 中, Caddy 的唯一作用是静态文件服务 + COOP/COEP header。
- Nginx 完全可以做这两件事。
- 保留 Caddy = 多一层代理, 多一个 COOP/COEP 配置出错点, 多一个需要维护的进程。
- 去掉 Caddy = Nginx 直接管静态 + API, COOP/COEP/CORP 全在 Nginx 一层配置。

**明确结论**: **去掉 Caddy**。Nginx 直接管静态文件 + API 反代。理由:
1. 减少一层代理 = 减少一个 COOP/COEP 配置出错点
2. 减少一个需要维护的进程 (systemd unit)
3. Nginx 静态文件服务性能优于 Caddy 反代
4. Caddy 的自动 HTTPS 在这个架构中没用 (Nginx 已经终结 SSL)

### M5. 服务器磁盘满时的降级策略不明确

**现状**: §11.1 提到 "checkin 写文件失败 → 500", 但没有细化:
- 服务器磁盘满时, snapshot.zip.tmp 写失败, 返回 500
- 客户端重试 3 次仍失败 → syncState = 'error'
- 旧 snapshot.zip 不受影响 (tmp → rename 保护了)
- 锁不释放 (设计如此, step 4-5 失败不释放锁)
- 客户端数据在本地完好

**评估**: 这个降级是正确的。旧数据安全, 新数据在本地等待。建议在文档中明确写出这个分析, 而不是只写 "监控告警"。

### M6. CORS / Origin 校验缺失

**现状**: §7 认证设计只提共享 token, 没有提 Origin 校验。

**问题**: 虽然是同源请求, 但如果攻击者在恶意网页中发 `fetch('https://maohedong.top/api/sync/state')`, 这会是一个跨源请求:
- 简单 GET 请求会发出 (CORS 对简单请求是 "检查响应" 而非 "阻止请求发出")
- 如果响应没有 `Access-Control-Allow-Origin`, 浏览器会阻止 JS 读取响应
- 但 `X-Sync-Token` 是自定义 header, 会使请求变为 "非简单请求", 触发 preflight OPTIONS
- 如果服务端不响应 OPTIONS, preflight 失败, 实际请求不发出

**但**: `/api/sync/state` 文档说 token 可选 (§2.1)。没有 token 也能看状态。攻击者的网页可以通过 `<img>` 或 `<link>` 发简单 GET (不带自定义 header), 但无法读取响应 (CORP same-origin 会阻止)。所以泄漏风险很低。

**checkin/checkout**: 带 `X-Sync-Token` 自定义 header → 触发 preflight → 服务端需要正确响应 OPTIONS (否则浏览器自己拦截, 这反而是保护)。但如果服务端配置了 CORS 允许所有 Origin (`Access-Control-Allow-Origin: *`), 就有风险。

**建议**:
1. 服务端不设置任何 `Access-Control-Allow-Origin` (不响应 CORS), 同源请求不受影响
2. Express 不需要 `cors` 中间件 (文档已正确说明)
3. 文档明确写出: "服务端不处理 OPTIONS preflight, 跨源请求被浏览器自动拦截, 这是期望行为"

### M7. 暴力破解防护: 10/min 限速对 token 空间足够, 但 state 端点无认证

**现状**: §2.1 state 端点不强制认证。§7.4 state 端点限速 60/min/IP。

**问题**: 攻击者可以不加 token 高频请求 state 端点, 获取锁状态、版本号、持锁者信息 (clientId + clientLabel)。虽然不含医疗数据, 但 clientId 和 clientLabel 是可枚举的元数据。

**评估**: 2 人家庭场景, clientId 和 clientLabel 不是敏感信息 (如 "爸爸的手机")。state 端点不认证是可接受的取舍, 但应该在文档中明确记录风险。

---

## 可选改进 (nice-to-have)

### O1. 轮询间隔自适应

§9.6 固定 30s 轮询。可以改为: 前 2 分钟每 10s 轮询 (快速感知锁释放), 之后每 30s (省资源)。但 2 人场景 30s 固定完全够用, 不改。

### O2. clientId 在多 tab 场景的行为

§11.1 提到 "多 tab 同时打开, clientId 相同, 都认为自己持锁"。当前设计不处理这个。建议: 在 useSync 初始化时检查是否已有其他 tab 在编辑 (BroadcastChannel), 如果有则当前 tab 只读。但 2 人家庭场景不太会开多 tab, 可列为未来改进。

### O3. 服务器保留最近 3 个 snapshot

当前只保留最新 snapshot。考虑保留最近 3 个: 每次 checkin 时把旧 snapshot 重命名为 snapshot-v{N-1}.zip。占用 3x 磁盘但提供回滚能力。对 2 人家庭, 数据量不大, 可接受。列为可选改进。

### O4. Token 在 localStorage 的 XSS 风险

§7 客户端存储用 localStorage, 与 AI 配置同模式。任何 XSS 漏洞都能偷到 token。2 人自用场景, 攻击面主要来自第三方依赖 (npm 包被污染)。建议:
1. 生产环境不上 sourcemap
2. 定期 `npm audit`
3. 如果未来需要更高安全, 可改为用户手动输入 token (不持久化), 每次打开 app 输入

### O5. 加密 snapshot.zip

snapshot.zip 是明文 sqlite, 包含家庭病史。如果服务器被入侵或 token 泄露, 全家病史暴露。可以考虑客户端加密 zip (AES-GCM), 密钥从 token 派生 (PBKDF2)。但:
- 增加 CPU 开销 (加密几十 MB zip)
- 密钥管理复杂 (token 就是密钥来源, token 泄露 = 密钥泄露, 意义有限)
- 2 人自用场景, 服务器在自己控制下, at-risk 但可接受

列为未来改进, 不在 Phase 2 实施。

---

## 五大维度结论

### 数据安全: 有保留
- checkin 的 tmp→rename 策略保护了服务器快照不被半截文件覆盖 (PASS)
- 但 importAllData 中途失败会导致本地 sqlite/blobs 不一致 (S2, 需要修复)
- version.txt 与 snapshot.zip 的非原子写入顺序应调整 (S1, 需要修复)
- 服务器磁盘满的降级正确 (PASS)

### 竞态条件: PASS
- 进程内 Mutex 串行化覆盖了所有并发 (2 人 + 单进程场景)
- clientId + version 双重校验有效阻止过期 checkin
- heartbeat 失败后的客户端状态转换需要更及时 (M2)

### COOP/COEP: PASS
- 同源 fetch 不需要 CORP 头 (浏览器规范确认)
- 加 CORP 头是正确的保险措施, 尤其 `always` 确保错误响应也带
- 上传不受 COEP 限制 (COEP 只检查响应)
- **明确决策**: 去掉 Caddy, Nginx 一层管全部 (M4)

### UX: 有保留
- 锁过期提醒 + 轮询设计合理
- beforeunload auto-checkin 必须放弃 (S4, 已给明确结论)
- 首次同步场景 B 需要二次确认 (M3)
- version 冲突的处理流程清晰 (§5.1)
- heartbeat 失败后应更早通知用户 (M2)

### 安全: PASS (2 人自用场景)
- 共享 token + timingSafeEqual 足够
- 进程内限速覆盖暴力破解
- state 端点无认证是可接受取舍
- CORS 不配置 (同源) 是正确选择
- localStorage token 存储与现有 AI 配置一致, 自用场景可接受

---

## 推荐修订清单

1. **§2.4** checkin 原子性: 调整 step 5-6 顺序为「先写 version.txt, 再写 snapshot.zip」, 添加理由说明
2. **§2.4** checkin 原子性: 添加 snapshot.zip.tmp 写入失败时服务端返回 503 (而非 500), 客户端可安全重试
3. **§4.2** checkout 流程: 在 importAllData 前增加「自动导出本地备份」步骤 (存内存 Blob)
4. **§4.4** 浏览器关闭处理: 删除 auto-checkin (fetch keepalive) 方案, 改为纯提示 + TTL 兜底
5. **§4.4** 添加明确结论: 放弃 auto-checkin, 改用 "beforeunload 只提示 + 本地数据靠 OPFS/IDB 持久化 + TTL 30 分钟兜底" 策略
6. **§6.7** Caddy 层去留: 明确决策 "去掉 Caddy", 删除替代方案对比, 只保留 Nginx 方案
7. **§6.2** COEP 分析: 明确结论 "同源 fetch 无需 CORP 头, 但加 same-origin 作为保险"
8. **§6.7** 添加 curl 验证示例
9. **§9.5** heartbeat: 连续失败从 3 次降为 2 次触发 error 状态, 首次失败弹非阻塞 toast
10. **§10.3** 场景 B: 增加二次确认对话框
11. **§10.4** 删除 autoCheckin 代码示例, 替换为纯提示策略
12. **§7** 认证: 添加 "服务端不处理 OPTIONS preflight, 跨源请求被浏览器拦截, 期望行为" 说明
13. **§3.1** TTL 策略: 添加明确取舍声明 "30 分钟 TTL 是家庭场景的合理取舍, 浏览器崩溃后等待 30 分钟可接受"
14. **§5** 冲突矩阵: 补充 force-release + 原持有者 checkin 的场景分析
15. **§11.1** 服务器磁盘满: 补充详细降级分析 (旧快照安全, 新数据在本地等待)
16. **§2.0** 错误码语义表: snapshot.zip.tmp 写失败时返回 503 而非 500
17. **附录 D**: 更新时间常量表 (如有变化)
18. **§10.2** 锁过期提醒: 添加 "heartbeat 首次失败时弹 toast" 的 UX 行为
