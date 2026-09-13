# Workflow v2 交接文档

**用途**：在新会话里继续这项工作，无需重读全部历史。

**读取顺序**：先读本文件（当前状态 + 不要重新踩的坑），再读同目录的 [`conductor-spec.zh-CN.md`](conductor-spec.zh-CN.md)（设计契约，M5 之后的所有实现都按它走）。在 Pi 里人工验证见 [`conductor-verify.zh-CN.md`](conductor-verify.zh-CN.md)。

---

## 1. 这件事是什么

把 `my-pi-setup` 的 `extensions/workflows` 从**扇出执行器**重构成**指挥（conductor）**：

- **执行什么**由一份按当前 task 合成、经用户批准的 **Plan** 决定，而不是模型每次临场写编排 JS。
- **引擎不懂方法论**。procedure / 闸门 / 合法迁移由可插拔的 **Methodology Provider** 提供，`pi-packages` 的 `pi-matt-pocock` 是第一个 provider。它的 `src/catalog.json` 已经是半个编译器 IR（节点、边 `allowedNext`、相位、依赖闭包），缺的只是后端。
- **执行过程带状态**：每步落盘 checkpoint，模型服务异常 / 工具限流 / 进程死亡之后能接着跑。

一句话概括三层分工：**matt-pocock = 做什么；Plan IR = 这次做什么；引擎 = 怎么跑、怎么记、怎么恢复。**

用户的原始构思（保留原话要点）：用 my-pi-setup 的动态生成 workflow 代码，把 matt-pocock 的方法论 + 声明式路线状态机**固化**下来，避免纯声明式的不确定性。"固化"是相对的——不是编译 5 条固定路线，而是按 task 合成、批准即固化。7×24 云端执行是长期目标（规格 N1），**本版不做**。

---

## 2. 当前状态

**仓库**：`FanXiang/my-pi-setup`　**分支**：`claude/workflow-v2-conductor-m5-gwteyg`（已推送，工作区干净；它与 `claude/beautiful-shannon-wr1ndr` 同源，M5 之前两者内容完全一致）

```
3915000 feat(workflows): admit a plan before it runs                                 ← M5
604e654 docs(workflows): add an in-Pi verification playbook for M1-M4
7739789 feat(workflows): escalate instead of asking, and suspend on a real blocker   ← M4
a06f214 feat(workflows): resume a run from an append-only agent-call ledger          ← M2 + M3 核心
0c93e6c feat(workflows): wire the throttle governor into workflow runs               ← M1 接线
8acd228 docs(workflows): record the SDK retry findings and revise the retry design   ← Q1 结论
c0f1e3d feat(workflows): classify agent failures and govern run-wide throttling      ← M1
6df7969 docs(workflows): add conductor workflow v2 spec for review                   ← 规格
```

M1–M4：25 个文件，+4559 / −89。M5 另加 5 个模块 + 4 个测试文件。

| 里程碑 | 状态 |
| --- | --- |
| M1 错误分类 + 重试观测 + 限流治理 | ✅ |
| M2 台账 + 恢复 | ✅ |
| M3 git SHA 钉住与传递作废 | 🟡 核心已随 M2 落地；**精确**传递作废等 Plan IR 的 `blockedBy`，现为"其后全部"的保守近似 |
| M4 L1/L2/L3 + 通知送达 + 回答消费 | ✅ |
| M5 Plan IR + 校验器 V1–V10 | ✅ |
| **M6 matt-pocock provider 适配 + 闸门 schema** | ⬜ **下一个任务** |
| M7 inline 步骤 + `workflow_report` | ⬜ |
| M8 仪表盘（DAG / ledger / 等你 / 节流 / 恢复入口） | ⬜ |
| M9 frontier 走子（多步 DAG 并发调度） | ⬜ |

**未做的硬性项**（规格 §12 改动清单里仍待）：移除 `prompt.ts` 的 "ultracode" 口令闸门、headless 执行路径（`index.ts` 的 `background = ... && ctx.hasUI`）、detached run 脱离会话（`session_shutdown` 仍全量 abort）、`runner.ts` 的 `SessionManager.inMemory` → 持久化 + 接管、按步骤覆盖超时。

---

## 3. 已验证的关键事实（不要重新推导）

### 3.1 SDK 侧（Q1 的结论，读的是 pi-ai@0.82.1 / pi-coding-agent@0.82.1 的实际产物）

- **扩展侧拿不到 HTTP 状态码和 `retry-after`**。`status` / `headers` 只存在于 pi-ai 内部（`dist/utils/provider-retry.js` 的 `isProviderError`、`getRetryDelayMs`），被 `retryProviderRequest` 消费掉。扩展只有 `AssistantMessage.errorMessage?: string` + `stopReason`。
- **唯一泄漏的结构化信息**：服务端要求的延迟超过 `maxRetryDelayMs`（默认 60s）时，消息形如 `Server requested 90s retry delay (max: 60s). <原文>`，可解析出真实 `retryAfterMs`。`failure.ts` 的 `parseServerRequestedDelayMs` 就干这个。
- **分类器是公开的**：`isRetryableAssistantError()` / `isContextOverflow()` 从 `@earendil-works/pi-ai` 根导出（`dist/index.js` 重导出 `utils/retry.js` 与 `utils/overflow.js`）。**用它们，不要另写一套**——它们的模式表正是 SDK 自己重试循环所用的那份，已包含把配额类 429 判为不可重试。
- **SDK 已有三层重试**：HTTP 请求层（`retryProviderRequest`）、单次 assistant 调用层（`retryAssistantCall`）、会话轮次层（`agent-session.js` 的 `_prepareRetry`，默认 3 次、base 2000ms）。**引擎绝不能再加第四层**，否则变成乘法。
- **`auto_retry_start` / `auto_retry_end` 在公开事件联合里**（`agent-session.d.ts:72,78`），带 `attempt` / `maxAttempts` / `delayMs` / `errorMessage`。这是最早能观测到限流的时刻——子 agent 还在退避中。
- **`ask_user` 被从子 agent 排除**（`extensions/shared/child-session.ts:21` 的 `CHILD_EXCLUDED_TOOL_NAMES`）。所以执行期的人类介入只能走 `block()` 挂起，不能走提问。
- `SettingsManager.setRetryEnabled()` 写的是**用户全局设置文件**。用户若全局关掉重试，子 agent 会继承——**只能提示，不可代为改写**（规格不变量 9）。

### 3.2 本仓库侧

- **台账键不能用调用序号**。`sandbox-child.cjs` 的 `mapLimited` 把下一个数组下标交给最先完成的 worker，所以超过并发数后调用发起顺序在两次运行之间不一致。必须内容寻址。
- **出现序号每次尝试从 0 重数**，不从台账 seed。seed 会让键整体偏移，整个缓存一条都命中不了。
- **`safeStringify` 是缩进 2 的 pretty-print**（`serialization.ts:126`），**不能**用于 JSONL——会把每条记录拆成多行。台账与升级记录都用 `toSerializable` + 无缩进 `JSON.stringify`。
- **`toSerializable` 会把重复的对象引用替换成 `"[circular]"` 标记**。台账的 `before`/`after` 因此重建成全新普通对象：共享引用会让 `after` 变成字符串 → 判定"未知副作用" → 永不匹配 → **静默丢失全部缓存**。`ledger.test.ts` 里"传同一对象"的写法是刻意保留的回归守卫。
- **构造函数参数属性（`constructor(private readonly x)`）会让 Node 的 `--experimental-strip-types` 报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`**，整个测试文件失败。这个坑踩了两次（`RunController`、`LedgerWriter`）。用显式字段 + 构造函数内赋值。枚举和 namespace 同理。
- **并发子 agent 共享同一个 `ctx.cwd`**（`index.ts` 的 `createWorkflowResources(ctx.cwd, ...)`），并发上限 4。只读扇出没问题，**可写扇出会互相踩工作区**——这是规格校验 V8 要强制 worktree 隔离的原因，也是台账保守作废的诱因之一。
- `sandbox.ts` 的 `MAX_AGENT_REQUESTS = 64` 是 **IPC 跑飞防护**（恢复时脚本会重放全部调用含命中的），真实花费由 `controller.ts` 的 `MAX_AGENT_CALLS = 32` 封顶并跨恢复累计。两者含义不同，不要合并。

### 3.3 M5 新增的事实

- **`canonicalJson` 已从 `ledger.ts` 上提到 `serialization.ts`**（函数体逐字未改，所以已有台账的哈希不变）。台账键、blocker id、`planHash` 必须对同一个"规范"达成一致；两份定义漂移会让同一个哈希在不同文件里含义不同，而且**失败是静默的**：一个永不命中的缓存，或一个永不匹配的批准。`runner.ts` 的 `isJsonSchema` 同样上提为 `isBoundedJsonObject`，供 V4 复用。
- **`workflow_plan` 校验失败时正常返回，不 `throw`**。这正是 §7 里那条待决问题的处理方式：模型对工具失败的自然反应是重试，而原样重试同一份计划只会得到同一条拒绝。需要模型改东西的结果，不该长得像"再试一次"。
- **没有 provider 时 `workflow_plan` 拒绝整份计划**，而不是跳过 V1/V2。对着空 provider 校验会让这两条"沉默地通过"，计划就会*看起来*被检查过——比直接拒绝糟得多。
- **V8 的"任意时刻最多一个写仓步骤"是静态判定的**：任意两个 `repo` 步骤必须被 DAG 全序（一个可达另一个）。`kind: "fanout"` + `effects: "repo"` 直接拒——那正是 3.2 里那个活 bug 的形状。
- **校验器一次报出全部问题**。一轮计划应该暴露所有毛病，而不是第一个毛病；否则修四次、每次才发现下一处，而它们从一开始就都在。

### 3.4 环境

- `node_modules` 未提交。新会话需先 `npm install`（约 12 秒，261 包）。
- **本容器是 Node v22，仓库 `@types/node` 是 `^26`**。后果：`runner.test.ts` 里有 **3 个先前就存在的 watchdog 测试在 Node 22 下挂住**（`createFirstResponseWatchdog` 的 `timer.unref()` 让事件循环提前空闲），它们会**取消同文件后面的所有测试**。在 Node 22 下验证 `runner.test.ts` 的新测试必须用 `--test-name-pattern` 单独跑。**不要**基于 Node 22 的表现去"修"那 3 个测试。
- `extensions/workflows` 的 `tsc` 基线是**零错误**，必须保持。仓库其他扩展有 216 个先前就存在的错误（它们各有自己的 package.json，依赖未装），与本工作无关。

---

## 4. 新增模块地图

| 文件 | 职责 |
| --- | --- |
| `failure.ts` | 失败分类：12 个 `FailureClass` + `transient` / `throttle` 两个标记。`transient` 交给 SDK 判定，本地模式只决定是哪一类。**分类优先级即语义**：`aborted`/`contextOverflow` 先于一切文本匹配；**配额模式先于限流模式**（配额限制以 429 语义返回，当节流会让 run 等一个永不打开的窗口） |
| `governor.ts` | run 级 `RateLimitGovernor`：任一 child 报限流 → 并发塌到 1 + 暂停新准入；窗口**只延不缩**、有上限；成功后加性回升（AIMD）。在途 agent 永不取消，只收窄准入。`wait()` 的定时器**刻意不 unref**——有调用方被它阻塞，那是真实待办 |
| `ledger.ts` | 内容寻址键（`inputHash#occurrence`）、append-only JSONL、`replayLedger` 复用判定。后来的失败覆盖先前同键的成功 |
| `worktree.ts` | git 状态探针。`callHadEffects()`：只有"前后都干净且 HEAD 未动"才算无副作用，其余（含探测失败）一律钉住。判错只是多跑一次，反方向是产出错的东西 |
| `escalation.ts` | L1/L2/L3 + replan 的类型、**输入校验**（脚本是模型写的，契约在边界强制）、内容寻址 blocker id、文件 IO。假设默认不可逆 |
| `plan.ts` | Plan IR 类型 + `planHash`（规范化 JSON 去掉 `approval` 后 sha256）+ **边界解析** `normalizePlanInput`。计划是模型写的，所以契约在这里强制：拿到 `Plan` 值的模块都可以假定它结构良好，因为**没有别的地方能造出一个** |
| `gate.ts` | 8 算子声明式求值器。求值器**一次报出全部失败**——一条条告诉子 agent 会把一次修复变成四次。`schema` 那一层不在这里跑（见规格 §3.2） |
| `validate.ts` | V1–V10。**报告而不抛出**，且不在第一条失败处停 |
| `plan-store.ts` | `~/.pi/agent/workflows/plans/<planId>.json`，缩进写（计划是给人读和 diff 的）。回读必过 `normalizePlanInput`：是我们自己写的文件，但文件是人能编辑的东西 |
| `provider.ts` | `MethodologyProvider` 接口 + 注册表。引擎里**没有任何地方能点名一个 provider**，这是"引擎不懂方法论"从原则变成事实的地方 |
| `notify.ts` | `NotifyChannel` 可插拔；file（总是可用，写 `NEEDS-INPUT.md`）+ ui。逐通道记录送达，一个都没成功时 run 在自己的 `error` 字段说出来 |

**run 目录布局**（`~/.pi/agent/workflows/<runId>/`）：`script.js` `args.json` `workflow.json` `ledger.jsonl` `assumptions.jsonl` `flags.jsonl` `answers.jsonl` `blockers/<id>.json` `replan.json` `NEEDS-INPUT.md` `transcripts.json` `result.json`

**沙箱原语**：`agent` `parallel` `phase` `args` `assume` `flag` `block` `replan`

**工具**：`workflow`（新增 `resume` 参数）、`workflow_answer`、`workflow_plan`（M5 新增：合成 + 校验，**不执行**）

**计划目录**：`~/.pi/agent/workflows/plans/<planId>.json`

---

## 5. 下一个任务：M6（matt-pocock provider 适配器 + 闸门 schema）

**为什么是它**：M5 把 `workflow_plan` 接上了，但**它现在会拒绝每一份计划**——没有任何 provider 注册，而对着"没有 provider"去跑 V1/V2 等于让它们默默通过，那比拒绝更糟（计划会*看起来*被检查过）。所以 M6 之前，计划这条路是通的但没有入口。这是 M5 诚实的边界，不是遗漏。

**内容**（规格 §8，方案 A）：

1. 适配器直接读已安装的 `pi-matt-pocock` 包目录，解析 `catalog.json` → `listProcedures()`
2. `validateEdge` 接 `src/catalog.ts` 的 `allowedTransitions`（即 `src/workflow.ts:60` `transitionState` 今天在运行时做的检查，**前移到计划校验期**）
3. `loadBrief` 复用 `src/resolver.ts` 的依赖闭包 + `<procedure-source>` 包装 + 64 KiB 上限
4. `gateFor`：**新增** `packages/matt-pocock/schemas/*.json`，对应 `procedures/*-FORMAT.md`
5. `catalogHash` 用于检测 provider 漂移——`workflow_plan` 已经在比对它了
6. 在扩展加载时 `registerMethodologyProvider()`

**验收**：单张 AFK ticket 端到端——澄清 → 一份 agent brief → implement → code-review → handoff，全程零 ask，闸门生效。

**注意 `defaultStepKind` / `maxEscalation` 的分量不同**：前者是建议（计划可覆盖），后者是**硬上限**（V5 会拒超过它的计划）。provider 是唯一有资格说"这个 procedure 绝不该停下来等人"的一方。

**M6 之前不要去走 DAG**（规格 §13 原话）。先用单张 ticket 把 ledger / 升级 / 恢复这条循环跑通，frontier 调度留给 M9。

## 6. 未决问题

| # | 问题 | 我的倾向 |
| --- | --- | --- |
| **Q1b** | 用户全局关掉 `retry.enabled` 时，工作流子 agent 继承关闭、长跑变脆。(a) 检测到就提示、尊重用户设置；(b) 给工作流独立的重试配置键 | **(a)**。`setRetryEnabled()` 会改写用户全局设置文件，引擎无权这么做 |
| ~~Q2~~ | ~~计划由谁合成~~ | **已拍板 (a)**：模型按 `listProcedures()` 自己拼；`suggestPlan?()` 作为可选钩子保留在接口里、不实现，M6 可填。让计划安全的是 V1–V10，不是 provider |
| **Q3** | `workItemId` 与 matt-pocock 现有会话态（`src/workflow.ts` 的 `WORKFLOW_STATE_ENTRY`）如何对齐 | 共用 `workItemId` 但各记各的（低耦合）；`/matt-pocock` 菜单里能看到关联 run |
| **Q4** | detached run 本版是否真脱离会话 | 最小可行：会话结束前落盘，下次恢复。真脱离留给 N1 |
| ~~Q5~~ | ~~`gate.verify` 是否限制为白名单~~ | **已拍板：限制为 `package.json` scripts**，且是结构性限制——IR 里没有能装 shell 字符串的字段，`verify.command` 会被显式拒绝并提示改用 `script` |
| **Q6** | 闸门谓词算子集是否够用（现给 8 个） | 宁可窄开始。M5 已按 8 个实现，**等 M6 用真实闸门跑过再决定要不要加** |
| **Q7** ⚠️ | `script` 逃生口是否保留 | 保留，但仅限 `mode: "foreground"`。**M5 刻意没实现这条限制**——它还没被拍板，校验器不该执行未决的策略。要的话就是 V7 加一行 |

---

## 7. 验证命令

```bash
cd ~/my-pi-setup && npm install          # node_modules 未提交

npx tsc --noEmit 2>&1 | grep extensions/workflows   # 必须为空
npx prettier --check "extensions/workflows/**/*.{ts,cjs}" "extensions/shared/*.ts"
node --test --experimental-strip-types extensions/workflows/*.test.ts
# Node 22 下 runner.test.ts 的新测试要单独跑：
node --test --experimental-strip-types --test-name-pattern="retr|throttle" extensions/workflows/runner.test.ts
```

**当前基线**：180 个测试 / 173 通过 / **0 失败** / 7 cancelled（cancelled 全在 `runner.test.ts`，= Node 22 下先前就挂住的那几个 + 被连带取消的；M5 一个都没增减）。M5 新增 79 个测试：`plan` 23 / `gate` 17 / `validate` 31 / `plan-store` 8。

**端到端未验证**：工具层集成（`resume`、`block` 挂起 → `workflow_answer` → 恢复）**没有自动化测试**，需要真实 Pi 运行时。被测的是它依赖的契约层。人工验证步骤见 [`conductor-verify.zh-CN.md`](conductor-verify.zh-CN.md)（7 个场景，含隔离 agent 目录的做法）。

**测试会撞上的一个待决问题**：前台 run 非 `completed` 结束时工具是 `throw` 出去的（`index.ts:1189`），所以 `awaiting-input` 显示成工具失败，而模型对工具失败的自然反应是重试——不带 `resume` 的重试会开新 run、新 blocker、白花钱。建议把 `awaiting-input` / `replan-required` 改为正常返回，`failed` / `aborted` 继续抛。**尚未改动**，需先决定。

---

## 8. 不要破坏的不变量（规格 §15 全文，这里是要点）

1. `ledger.jsonl` / `answers.jsonl` 只追加，永不改写历史行。
2. 引擎不 import 任何 provider 专有概念；provider 只被只读查询，无执行权。
3. 未批准（`planHash` 不符）的计划不得 detached 运行。
4. 有效 `ok` 的台账条目永不重跑。
5. 写过的调用必须钉 `headSha`，恢复时必须校验。
6. 执行期不向用户提问：只有 L1/L2/L3 与 `replan`。
7. 没有任何通道确认送达的 L3，必须在 run 的 `error` 字段里说出来。
8. 全部 run 状态可由外部进程仅凭磁盘重建（为 7×24 留门）。
9. 不改写用户全局设置文件。
10. 不在 SDK 已有重试之上叠加步骤内重试。
11. 台账命中不消耗预算、不占并发槽。
12. 同一个 run 目录同时只能有一个活动 run 在写。
13. `workflow_answer` 只接受 blocker 列出的选项之一。

---

## 9. 新会话开场可直接粘贴

> 继续 `my-pi-setup` 的 Workflow v2 指挥型工作流重构。分支 `claude/workflow-v2-conductor-m5-gwteyg`。
> 先读 `extensions/workflows/docs/conductor-handoff.zh-CN.md`（交接文档）和 `conductor-spec.zh-CN.md`（设计契约）。
> M1/M2/M4/M5 已完成、M3 核心已落地。下一个任务是 M6（matt-pocock provider 适配器，方案 A + 闸门 schema）。
> 注意：`workflow_plan` 现在会拒绝每一份计划，因为还没有任何 provider 注册——这是 M5 诚实的边界，M6 正是补上它。
> 环境：先 `npm install`；本容器 Node 22 而仓库目标 Node 26，`runner.test.ts` 有先前就挂住的测试会连带取消同文件后续测试，用 `--test-name-pattern` 单独验证。
