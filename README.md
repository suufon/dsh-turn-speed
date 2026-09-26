# dsh-turn-speed

给 DeepSeek Harness 的「会话统计」弹窗加一个**本轮**视角：在官方那几行（模型用时 / 工具调用用时 / 首 token 平均（TTFT）/ 输出速度（TPS））下面，直接追加本轮对应的读数。

```
会话统计
──────────────────────────
模型用时            12.4秒
工具调用用时         3.1秒
首 token 平均（TTFT） 1.2秒
输出速度（TPS）      262 tok/s
──────────────────────────   ← 分割线：以上是官方原生项
本轮输出速度（TPS）   268 tok/s   ← 本插件
本轮端到端速度       231 tok/s
本轮首 token（TTFT）  1.1秒
本轮用时            18.7秒
本轮输出 tokens     5,014 tok
本轮步数               6
轮次                第 42 轮
```

官方那几项（会话级）和插件这几项（本轮）之间有一条**分割线**。没有它，弹窗就是一串不加区分的列表，「会话平均」和「本轮」看起来可以互换——这正是最容易误读的地方。分割线复用弹窗自己标题分隔线的 `.5px solid var(--dsw-alias-border-l2)`，因此看上去是弹窗自身的一部分，而不是外挂。

实现上它是一个零高度、`grid-column:1/-1` 的 `<dt>`：弹窗的详情区是两列网格（`minmax(76px,auto) minmax(0,1fr)`），只有跨列才不会在 16px 列间距处断成一根短横。样式表在首次注入时进 `<head>`（`<head>` 不在 MutationObserver 的观察范围内，所以它不会反过来触发渲染），选择器用属性而非上游的哈希类名限定，因此既能压过上游的 `.bRhRbq_details dt`，又不依赖会随构建变化的类名。分割线与各行同属「本插件的块」，因此同样被尾部校验覆盖、同样在弹窗关闭时被清理。

## 两行速度不是重复的

| 行 | 口径 | 回答的问题 |
| --- | --- | --- |
| 本轮输出速度（TPS） | Σ 本轮输出 tokens ÷ Σ（首 token → 该步完成） | **模型生成时有多快**：排除 TTFT 与工具等待，与官方「输出速度（TPS）」同一算法，只是范围缩到本轮 |
| 本轮端到端速度 | Σ 本轮输出 tokens ÷ 本轮墙钟时间 | **用户实际等了多久**：把 TTFT、工具调用、重试全部计入 |

所以本轮 decode 值高于端到端值是正常的，差额就是等待成本的占比。本轮各行的口径刻意与官方投影逐项对齐——包括「首 token **平均**」定义为 Σ÷步数、而不是取最快的一步——否则相邻两行会自相矛盾。

## 数值来源

不依赖官方弹窗内部状态，而是从 Session Controller 自己的事件窗口折叠：

```
ctx.sessions.list.getSnapshot().current   → 当前会话 id
ctx.sessions.binding(id).eventSource      → 事件窗口 { entries }
```

折叠算法是 `@deepseek-ai/dsh-session-stats` 那个官方 `sessionStats` 投影单元 `apply` 的逐行移植，所以本轮读数与官方会话级读数同源同算法——包括容易写错的细节：同一时刻只有一个 open step；首 token 时间按 `assistant/attempt` → live chunk → settlement 自身的 stream 顺序取**第一个**可用的；一步多次 settle 只计一次。包的流记录按 `time0 + 累加 dt` 还原每个 delta 的时间，与 `@deepseek-ai/dsh-llm` 的 `assistantStreamFirstTokenTime` 一致。

## 为什么是 DOM 注入

官方弹窗里那个 `<dl data-session-stats-details>` 是 ui-chat 写死的，弹窗内部**没有**任何 slot 可注册，因此只能把行作为该 `<dl>` 的尾部节点追加进去。与上游的耦合被压缩到极小且稳定的三处：`<dl>` 上的 `data-session-stats-details` 属性、弹窗的 `<html lang>` 语言、以及 `dt`/`dd` 的标准标签语义——不依赖上游的哈希类名，也不依赖内联样式。

- React 只会移除自己创建的节点，官方行始终是连续前缀，因此尾部追加是安全的；
- 每次变化都校验尾部是否仍恰好是本插件的行，不成立就重建——React 新插入一行到末尾时会自动纠正错位，是**收敛**而不是和 React 互相打架；
- 弹窗关闭（整个面板卸载）时本插件的行随之消失，无残留。

## 自证：不用打开浏览器控制台

宿主半在 Web 服务器上挂了免鉴权的 loopback 路由，浏览器半把自身状态 POST 过去，路由再以 JSON 读回：

```powershell
curl http://127.0.0.1:3080/turn-speed-api/health
curl http://127.0.0.1:3080/turn-speed-api/state
```

`/state` 会给出 `latest`（最近一次上报：`activated`、`hasSessions`、`current`、`hasBinding`、`windowEntries`、`dialogSeen`、`rows`、`lastError`、`model`）与 `pages`（每个上报过的页面）。最后一次上报同时落盘在 `$DSH_HOME/storages/dsh-turn-speed.json`。

这是刻意的设计：**静默不显示是这个插件最不能接受的失败模式**。浏览器半因此：

- `exports.inject = []` —— 一个声明了却永不 resolve 的 cordis inject 会让 `apply` 根本不执行，而没执行的插件无法解释自己为什么没执行；
- `sessions` 服务在 `apply` 内部等待（`lateBind`，最多 60 次 × 250ms），拿不到就上报失败而不是静默返回；
- 绑定（`binding(id)`）未就绪时按 250ms 重试，不会因为一次早退就让弹窗永远是空的；
- 诊断路由挂掉也绝不影响 UI，只是丢掉诊断信息。

## 安装

### 从 GitHub 安装（推荐）

```powershell
dsh plugin --profile web add github:suufon/dsh-turn-speed
```

想固定版本可加 tag：`dsh plugin --profile web add github:suufon/dsh-turn-speed#v0.2.0`

然后**重启 `dsh web`**：客户端 boot manifest 在服务启动时组装，刷新页面不足以让新插件出现。

```powershell
# 仓库自带脚本：自动探测 DSH_HOME / dsh CLI，并验证 /turn-speed-api/health
pwsh -File .\scripts\restart-web.ps1
```

### 本地开发（改源码即时生效）

```powershell
dsh plugin --profile web add link:<无空格的本地路径>
```

> `link:` 目标请用无空格路径。`link:` 规格是经 shell 传给 pnpm 的，含空格的路径会被拆成多个参数。源码路径含空格时，用 junction 绕开：

```powershell
New-Item -ItemType Junction -Path D:\dsh\plugins\dsh-turn-speed-src -Target "<含空格的源码路径>"
dsh plugin --profile web add link:D:\dsh\plugins\dsh-turn-speed-src
```

junction 建立后，源码目录下的改动即时生效（无需重新拷贝）；若工作区换了位置，重建 junction 并重新 link。

> 卸载：`dsh plugin --profile web remove dsh-turn-speed`

## 验证

```powershell
node scripts\verify.mjs
```

98 项检查，全部在浏览器之外跑真实代码：用手写的 `window.__ModuleLoader__` 与最小 DOM 物化浏览器半，覆盖 bundle 形状、折叠数学（含重试、重复 settle、包式流、运行中回合）、弹窗补丁（含 React 对账修复与关闭清理）、经 `ctx.sessions` 的激活路径（服务迟到、绑定迟到、路由掉线），以及宿主半的路由（loopback 限制、上报、落盘、重载恢复）。

## 已知边界

- 进行中的那一步没有计时（`partial` 只有 `{turn, step, blocks}`），因此速度类读数在**步边界**更新；「本轮用时」由本地每秒 tick 走动。
- 最新一轮若尚未产生可采样的结算，会显示**上一轮**并把标签改为「上一轮」，而不是编造一个数字。
- 数字由浏览器半折叠（它拥有事件窗口），宿主半只负责诊断通道与落盘。

## 许可

MIT
