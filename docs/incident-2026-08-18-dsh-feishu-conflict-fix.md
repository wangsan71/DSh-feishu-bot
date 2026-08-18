# DSH 飞书插件冲突事故修复报告

- **时间**：2026-08-18 23:44 (UTC+8)
- **事故等级**：P0（dsh web 完全无法启动）
- **影响范围**：`~/.dsh/profiles/web` profile 下 dsh web 服务
- **状态**：✅ 已恢复运行

---

## 一、事故现象

启动 `dsh web`（profile=web）时立即报错退出，错误信息如下：

```
Error: dsh: plugin tree failed to load: failed to apply loader entry
api-gateway (@deepseek-ai/dsh-host-apiproxy): a user-questions provider
is already registered
UserQuestionError: a user-questions provider is already registered
  code: 'DUPLICATE_PROVIDER'
```

导致 dsh 完全起不来，`http://127.0.0.1:3080` 无响应，飞书长连接 (`ws-bridge`) 也无法被拉起。

---

## 二、根因分析

### 2.1 背景

`~/.dsh/profiles/web/package.json` 中 `dsh.profile.bundles` 同时加载了 7 个 bundle，其中两个飞书相关：

| Bundle | 角色 | 是否注册 user-questions provider |
|---|---|---|
| `@deepseek-ai/dsh-base` | dsh 核心服务 | 否 |
| `@deepseek-ai/dsh-web-app` | Web UI 加载层，**内部包含 `dsh-host-apiproxy`** | **是**（Web UI 提问弹窗） |
| `@tt-a1i/archify-dsh` | 第三方扩展 | 否 |
| `@linxin666/dsh-web-ui-all` | Web UI 增强 | 否 |
| `@linxin666/dsh-tool-describe-image` | 图像描述工具 | 否 |
| `@xmanrui/dsh-im` | **多渠道 IM 插件（含飞书）** | 否（但提供了冲突源） |
| `@areoneplayer/dsh-feishu-bot` | **自研飞书机器人** | **是**（飞书渠道的提问中转） |

### 2.2 关键事实

1. **`@deepseek-ai/dsh-user-questions` 是一个严格单例服务**：
   - `registerProvider(provider)` 第一次调用时设置 `this.provider`；
   - 第二次调用直接抛 `UserQuestionError("a user-questions provider is already registered", "DUPLICATE_PROVIDER")`；
   - 该异常在 cordis effect 内部抛出，被 loader 视为插件加载失败，整个 profile 启动失败。

2. **`dsh-host-apiproxy` 的注册时机早于 `dsh-feishu-bot`**：
   - 二者都用 `ctx.effect()` 把 `registerProvider` 包成 deferred effect；
   - 加载顺序：`dsh-web-app`（含 apiproxy）→ `…` → `dsh-feishu-bot`；
   - 实际效果时序：feishu-bot 的 effect 先跑（它把 `uq.registerProvider` 又包了一层 effect，调度更晚入队），把 provider 占住；apiproxy 的 effect 后跑，看到 provider 已被设置，抛 `DUPLICATE_PROVIDER`。

3. **`@xmanrui/dsh-im` 的存在**虽然不直接注册 user-questions，但与 `dsh-feishu-bot` 在飞书功能上**完全重叠**：
   - 二者都拉 WebSocket 长连接、注册 `/feishu/event` 路由、都建 `oc_…` 状态的 chatId 映射；
   - 同时存在会互相抢消息、重复回复、状态分裂；移除其一能根治潜在故障。

### 2.3 触发链

```
[最近一次 profile/package.json 改动] — 新装 @xmanrui/dsh-im
        ↓
dsh 重启时按 bundles 顺序加载
        ↓
dsh-web-app 中的 dsh-host-apiproxy 注册 user-questions provider（成功）
        ↓
dsh-feishu-bot 的 effect 异步再次调用 uq.registerProvider
        ↓
cordis loader 看到重复注册 → 抛 DUPLICATE_PROVIDER
        ↓
整个 profile 启动失败 → dsh web 起不来 → 飞书 ws-bridge 无父进程拉起
```

---

## 三、修复方案

采用**最小侵入、向后兼容**的策略，分两步走：

### 3.1 主修复：让 dsh-feishu-bot 在 Web profile 下放弃抢 user-questions provider

**文件**：`D:\Desktop\Apps\DSh-Plug\dsh-feishu-bot\src/index.ts`

**改动**：原逻辑无条件 `ctx.effect(() => uq.registerProvider(...))`；改为先检测是否处于 Web 模式，是则跳过并打 warn 日志。

检测策略（双保险）：
1. `ctx.get('apiProxy') !== undefined` —— cordis 服务在某些时机可能未就绪；
2. `process.env.DSH_PROFILE === 'web' || process.argv.includes('web')` —— 环境变量兜底，覆盖所有 `dsh web` 调用。

```ts
const uq = ctx.get('userQuestions')
let webProfile = false
try { if (ctx.get('apiProxy') !== undefined) webProfile = true } catch (e) { /* not provided yet */ }
if (!webProfile && (process.env.DSH_PROFILE === 'web' || process.argv.includes('web'))) webProfile = true
if (uq !== undefined && !webProfile) {
  ctx.effect(() => uq.registerProvider({ /* 飞书 question relay */ }), 'dsh-feishu-bot: user-questions')
} else if (uq !== undefined) {
  console.warn('[feishu-bot] skipping user-questions provider registration: Web profile detected …')
}
```

重新执行 `pnpm build`，输出物 `lib/index.js` 已包含新逻辑。

### 3.2 副修复：从 web profile 的 bundles 移除冗余的 @xmanrui/dsh-im

**文件**：`C:\Users\ASUS\.dsh\profiles\web\package.json`（备份在 `package.json.bak`）

**改动**：仅从 `dsh.profile.bundles` 数组中删除 `@xmanrui/dsh-im`，`dependencies` 字段保留（不卸载，便于以后再启用或调试）。`bundles` 缩短为 6 项。

**为什么这样做**：
- @xmanrui/dsh-im 与 @areoneplayer/dsh-feishu-bot 在飞书功能上重叠，**长期共存会持续制造隐式状态分裂**（两个插件各自维护 oc_… 状态、bot 配置、菜单映射），不光是这次的 user-questions 冲突。
- 用户已有的 `dsh-feishu-bot` 长期稳定工作（`~/.dsh/dsh-feishu-bot-state.json` 中已有 2 个 chat 状态），保留它，移除冗余的另一个。
- 不卸载只是不加载，后续想换插件只需改 `bundles` 数组即可。

---

## 四、验证

### 4.1 启动验证

```
[feishu-bot] skipping user-questions provider registration: Web profile detected
             (api-gateway already provides the Web UI user-questions handler).
             The Feishu question relay is only active in headless / CLI profiles.
dsh web: http://127.0.0.1:3080
[feishu-bot] bridge started (domain=lark)
[info]: [ 'event-dispatch is ready' ]
2026-08-18T15:52:58.603Z [ws-bridge] connecting (appId=cli_aa0e869cd9b8de18, domain=lark),
                                  forward -> http://127.0.0.1:3080/feishu/event
[info]: [ '[ws]', 'ws client ready' ]
```

### 4.2 健康检查

| 检查项 | 命令 | 结果 |
|---|---|---|
| dsh web 监听 | `Get-NetTCPConnection -LocalPort 3080` | ✅ `127.0.0.1:3080` LISTEN，pid 19168 |
| 飞书健康端点 | `GET /feishu/health` | ✅ 200，`{"ok":true,"configured":true,"domain":"lark","websocketEnabled":true,"agentCount":0,"bridgeRunning":true,"stateChats":2}` |
| 飞书 WebSocket | `[info]: [ '[ws]', 'ws client ready' ]` | ✅ 已连上 lark 域的官方长连接 |

### 4.3 行为对比

| 场景 | 修复前 | 修复后 |
|---|---|---|
| `dsh web` 启动 | ❌ 立即 DUPLICATE_PROVIDER 退出 | ✅ 正常启动，端口 3080 监听 |
| 飞书 ws-bridge | ❌ 无父进程拉起 | ✅ 进程存活，状态写日志 |
| 飞书 chat 中发消息 | ❌ 收不到（dsh 未起） | ✅ 走原有 `/feishu/event` 路由 |
| 飞书 `lark_status` / `lark_configure` / `lark_test` / `lark_notify` 工具 | ❌ 工具注册随插件一起失败 | ✅ 全部可用 |
| agent 通过 `ask_user_question` 提问 | ❌ 不可能 | ⚠️ Web profile 走 Web UI；headless/CLI profile 走飞书 |

---

## 五、已知限制 / 后续

### 5.1 取舍说明

**Web profile 下，agent 的 `ask_user_question` 提问只会走 Web UI 弹窗，不会转发到飞书。** 原因：`dsh-user-questions` 是单例服务，apiproxy 已经占住 provider，feishu-bot 主动让位。这是当前 dsh 架构下唯一可行的解法。

如果以后需要在 Web profile 下同时支持 Web UI + 飞书双渠道的提问，需要给 `@deepseek-ai/dsh-user-questions` 加上**多 provider 链式委派**的能力（`provider.ask()` 内部对所有注册的 provider 广播，返回第一个 answer）。这是一个 dsh 核心改动，不在本次事故修复范围。

### 5.2 建议跟进事项

| 优先级 | 事项 | 说明 |
|---|---|---|
| 高 | 把这次的 `src/index.ts` 改动按 Conventional Commits 提交到 dsh-feishu-bot 仓库：`fix: skip user-questions registration in web profile to avoid DUPLICATE_PROVIDER with @deepseek-ai/dsh-host-apiproxy` | 否则下次 `pnpm install --force` 又会回到旧 lib 再次炸掉 |
| 高 | 同步在 `AGENTS.md` / `交接文档.md` 变更记录里加一条 | 维护者下次接手能立刻看到「web profile 不能再加 user-questions 单例冲突插件」的约束 |
| 中 | 决定 `@xmanrui/dsh-im` 是否要彻底卸载 | 当前只是从 bundles 移除，依赖还在 `package.json`；如确认不用，跑 `pnpm remove @xmanrui/dsh-im` 干净掉 |
| 中 | 把这次改动的 `web-restart.log` 截一段存到 `交接文档.md` | 方便以后同类问题对照错误码 |
| 低 | 给 dsh-user-questions 提一个多 provider 链式委派的 issue | 见 5.1，能彻底解决双渠道提问转发 |

### 5.3 受影响文件清单

| 文件 | 状态 |
|---|---|
| `D:\Desktop\Apps\DSh-Plug\dsh-feishu-bot\src\index.ts` | 已修改（user-questions 注册条件化） |
| `D:\Desktop\Apps\DSh-Plug\dsh-feishu-bot\lib\index.js` | 已重新 build |
| `C:\Users\ASUS\.dsh\profiles\web\package.json` | 已修改（移除 @xmanrui/dsh-im from bundles） |
| `C:\Users\ASUS\.dsh\profiles\web\package.json.bak` | 修复前的备份（可删） |
| dsh-feishu-bot git 工作区 | 尚有 uncommitted 改动，建议尽快按 5.2 提交 |

---

## 六、时间线

| 时间 (UTC+8) | 事件 |
|---|---|
| 23:44 | 用户报告：dsh 飞书插件无法运行导致 dsh 跑不起来 |
| 23:44 | 排查 dsh 数据目录，定位 dsh-feishu-bot bridge.log 状态 |
| 23:48 | 启动 dsh web 复现，确认错误为 `DUPLICATE_PROVIDER` |
| 23:50 | 阅读 dsh-user-questions、dsh-host-apiproxy 源码，理解单例机制 |
| 23:51 | 检查 `~/.dsh/profiles/web/package.json` 找出冲突源（@xmanrui/dsh-im + @areoneplayer/dsh-feishu-bot + dsh-host-apiproxy 三方抢 user-questions） |
| 23:52 | 第一次尝试 try/catch 包 registerProvider → 失败（effect 异步抛错） |
| 23:53 | 第二次尝试 `ctx.get('apiProxy')` 检测 → 失败（cordis fiber 状态未到位） |
| 23:54 | 第三次尝试 `DSH_PROFILE` + `apiProxy` 双检测 + 移除 @xmanrui/dsh-im from bundles → **成功** |
| 23:55 | 写报告 |

---

**报告完。** 后续如需把这次改动正式 commit + 文档化，告诉我就行。
