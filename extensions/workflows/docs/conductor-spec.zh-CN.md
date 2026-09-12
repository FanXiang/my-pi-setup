# Workflow v2：指挥型工作流规格（待审）

状态：**草案，待审**。本文件是后续实现的契约；代码尚未改动。

## 0. 背景与本版定位

现有 `extensions/workflows` 是一个**扇出执行器**：模型临场写一段编排 JS，在沙箱子进程里起隔离子 agent，跑完即弃（`prompt.ts` 明写 "There is no resume: a failed run is simply re-run"）。

v2 把它变成**指挥（conductor）**：

- 执行什么，由一份**按当前 task 合成、经用户批准的计划（Plan）**决定，而不是模型每次临场编排。
- 引擎自身**不懂方法论**。方法论（procedure、闸门、合法迁移）由可插拔的 **Methodology Provider** 提供，`pi-matt-pocock` 是第一个 provider。
- 执行过程**带状态**：每一步落盘成 checkpoint，模型服务异常、工具限流、进程死亡之后能**接着跑**，而不是从头重跑。

优先级（本版）：**checkpoint / 续跑 > 计划与校验 > matt-pocock 适配 > 指挥语义（inline）> 仪表盘**。

## 1. 目标与非目标

### 目标

1. **G1 续跑**：任意一步失败或进程死亡后，恢复时只重跑未完成的步骤；已完成步骤零成本。
2. **G2 抗限流/抗抖动**：provider 429/529/5xx、首响应停顿、工具超时，不消耗步骤进度，按退避重试；限流时全局降速而非并发重试。
3. **G3 计划可审**：执行前有一份可读、可校验、可 diff 的 Plan；批准即固化。
4. **G4 方法论可插拔**：matt-pocock 作为 provider 适配进来，引擎不硬编码其路线。
5. **G5 指挥语义**：计划中的步骤可以由主会话执行（保住原文上下文），而不是一律塞给子 agent。
6. **G6 AFK 可用**：执行期原则上零 ask；需要人时按三级升级策略处理，最高一级才挂起。

### 非目标（本版不做，但设计不得堵死）

- **N1** 7×24 常驻守护进程 / 跨机调度。本版只保证：run 的全部状态在磁盘上，除 `inline` 步骤外不依赖交互会话，供后续由外部 supervisor 接管。
- **N2** 自动修复计划（计划错了就终止并要求重新澄清，不自作主张改计划）。
- **N3** 基于成本的抢占与跨 run 全局调度。
- **N4** 计划合成的全自动化；合成由模型做，但必须过校验并由人批准。

## 2. 三层架构

```
┌───────────────────────────────────────────────────────────┐
│ Methodology Provider（可插拔）                            │
│  procedure 清单 / brief 载荷 / 闸门 schema / 合法边        │
│  首个实现：matt-pocock 适配器                             │
└──────────────────────┬────────────────────────────────────┘
                       │ 只读查询，无执行权
┌──────────────────────▼────────────────────────────────────┐
│ Plan IR（数据，冻结并哈希）                               │
│  步骤 DAG · 每步 kind/mode/闸门/升级等级/预算/副作用域    │
└──────────────────────┬────────────────────────────────────┘
                       │ 准入校验 V1–V9
┌──────────────────────▼────────────────────────────────────┐
│ Conductor Engine（方法论无关）                            │
│  frontier 调度 · ledger/checkpoint · 重试与限流治理       │
│  闸门判定 · 升级与挂起 · 子 agent 生命周期 · 仪表盘       │
└───────────────────────────────────────────────────────────┘
```

引擎对 provider 只做**只读查询**。provider 不能执行任何东西，也不能决定调度——这是"引擎不懂方法论"的硬边界。

## 3. Plan IR

### 3.1 类型

```ts
interface Plan {
  version: 2;
  planId: string;              // pl_<hex>
  workItemId: string;          // 复用 matt-pocock 的稳定 work item id
  task: {
    title: string;
    statement: string;         // 澄清后的任务陈述（人类可读，合成阶段产物）
    cwd: string;
    baseRef?: string;          // 计划基线 git ref
    branch?: string;           // 写仓步骤的目标分支
  };
  provider: { id: string; version: string; catalogHash: string };
  budget: PlanBudget;
  policy: RunPolicy;
  steps: Step[];
  approval?: {                 // 未批准的计划不可 detached 运行
    planHash: string;          // 见 3.4
    approvedAt: number;
    approvedBy: "user";
  };
}

interface PlanBudget {
  agentCalls: number;          // 计划级总预算（非单次尝试）
  concurrency: number;         // ≤ 引擎上限
  costUsd?: number;
  wallClockMs?: number;
}

interface RunPolicy {
  blockable: boolean;          // 是否允许出现 L3（挂起等人）
  maxEscalation: 1 | 2 | 3;    // 全局上限，步骤不得超过
  onGateFail: "repair-once" | "escalate";
  notify?: NotifyChannel[];    // L3 的送达渠道，detached 运行必填
}

type StepKind =
  | "inline"      // 主会话执行，引擎只下发指令并等回报
  | "serial"      // 单个子 agent，顺序
  | "fanout"      // N 个子 agent 并发 + 聚合
  | "script";     // 兼容旧版：一段沙箱编排 JS（逃生口）

type StepMode = "HITL" | "AFK";

interface Step {
  id: string;                  // 计划内唯一且稳定，例如 "s3-implement"
  kind: StepKind;
  mode: StepMode;
  procedure: string;           // provider 的 procedure id，如 "implement"
  label: string;
  blockedBy: string[];         // DAG 边
  brief: string;               // agent brief（AGENT-BRIEF 格式），这步的权威规格
  inputs?: StepInput[];        // 引用前驱步骤的结构化产物
  gate?: Gate;                 // AFK 步骤必填
  escalation: 1 | 2 | 3;
  effects: "readonly" | "worktree" | "repo";
  budget?: { agentCalls?: number; toolTimeoutMs?: number; firstResponseMs?: number };
  retry?: RetryPolicy;
  fanout?: { items: FanoutItem[]; concurrency?: number };
  model?: { provider?: string; id?: string; effort?: string };
}

interface StepInput {
  from: string;                // 前驱 step id
  path?: string;               // 取其结构化产物的字段路径
  as: string;                  // 注入 brief 的占位名
}

interface FanoutItem { key: string; brief: string }
```

### 3.2 闸门（Gate）

闸门把"完成"从**自证**变成**可检**。

```ts
interface Gate {
  schema: unknown;             // JSON Schema，作为 structured_output 的形状
  predicates: Predicate[];     // 对结构化产物的断言
  verify?: { command: string; expectExit: number };  // 可选的仓内校验（测试/lint）
}

interface Predicate {
  path: string;                // 点号路径，如 "acceptance_criteria"
  op: "exists" | "nonEmpty" | "minLength" | "maxLength"
    | "eq" | "ne" | "matches" | "everyNonEmpty";
  value?: unknown;
  message?: string;            // 失败时回灌给子 agent 的修复提示
}
```

谓词**刻意是声明式小语言，不是 JS**：它要在沙箱外求值、要能序列化进 ledger、要可审计，再开一个 eval 面不可接受。

闸门判定顺序：`schema` 校验 → `predicates` 全过 → 可选 `verify` 命令退出码匹配。任一不过 → `gate-failed`（**不是** transient，见 §5）。

### 3.3 步骤语义对照

| kind | 执行者 | 原文上下文 | detached 可用 | 典型 procedure |
| --- | --- | --- | --- | --- |
| `inline` | 主会话 | 保留 | **否** | implement（需原文时）、grill-me |
| `serial` | 单子 agent | 丢失（靠 brief 补） | 是 | to-spec、to-tickets、单条 research |
| `fanout` | N 子 agent | 丢失 | 是 | DESIGN-IT-TWICE、code-review 两轴、research frontier、triage |
| `script` | 沙箱 JS | 丢失 | 是 | 旧版临场编排（逃生口） |

`inline` 是"指挥而非代劳"的实现：引擎不起子 agent，它下发指令、卡闸门、不给产物就不许前进。代价是 `inline` 依赖主会话，**因此 detached 运行不得含 `inline`**（校验 V7）。这是一个必须明说的取舍：要 AFK，就得把该说的都写进 brief——`AGENT-BRIEF.md` 存在的理由正是"brief 必须替代那段对话"。

### 3.4 planHash 与固化

`planHash = sha256(规范化 JSON(plan 去掉 approval 字段))`。

批准写入 `approval.planHash`。运行时若重算哈希不等于 `approval.planHash`，**拒绝 detached 运行**，前台运行给出显式告警并要求重新批准。批准那一刻就是"固化"。

## 4. Checkpoint / Ledger（本版核心）

### 4.1 落盘布局

```
~/.pi/agent/workflows/<runId>/
  plan.json             # 冻结的计划
  run.json              # run 状态：status / cursor / attempt / throttleUntil
  ledger.jsonl          # append-only，每条 = 一个已结算的步骤或扇出项
  assumptions.jsonl     # L1 升级记录
  blockers/<id>.json    # 未关闭的 Attention Request
  answers.jsonl         # 人类对 blocker 的回答（重放时消费）
  steps/<stepId>/brief.md result.json transcript.json
  script.js args.json   # 仅 script 步骤
```

`ledger.jsonl` 与 `answers.jsonl` 是 **append-only**，任何恢复路径都不得改写历史行。

### 4.2 Ledger 记录

```ts
interface LedgerEntry {
  seq: number;
  stepId: string;
  itemKey?: string;            // 扇出项
  attempt: number;             // 从 1 起
  status: "ok" | "failed" | "gate-failed" | "skipped" | "answered";
  startedAt: number;
  finishedAt: number;
  inputHash: string;           // sha256(brief + schema + 已解析 inputs + procedureHash)
  baseSha?: string;            // 步骤开始前的 git HEAD
  headSha?: string;            // 步骤结束后的 git HEAD（effects ≠ readonly）
  worktreeClean?: boolean;
  structured?: unknown;        // 小产物内联；大产物写 steps/<id>/result.json 并用 outputRef
  outputRef?: string;
  gate?: { passed: boolean; failures?: string[] };
  failure?: FailureInfo;       // 见 §5.1
  usage: AgentUsage;
  model?: string;
}
```

失败的尝试**也写 ledger**（`status: "failed"`，带 `attempt`），用于可观测与重试计数；只有 `status: "ok"` 参与跳过判定。

### 4.3 恢复算法（规范）

```
1. 读 plan.json，重算 planHash；与 approval.planHash 不一致 → 拒绝恢复，要求重新批准。
2. 顺序读 ledger.jsonl，构造 latest: (stepId, itemKey?) → 最后一条记录。
3. 对每条 status=="ok" 的记录做"仍然有效"校验：
   a. 用当前计划重算 inputHash，不等 → 作废该条目。
   b. 若 step.effects != "readonly"：
        git rev-parse HEAD 必须等于 entry.headSha，
        且当前 worktree 干净状态必须等于 entry.worktreeClean，
        否则 → 作废该条目。
   c. 作废是传递的：沿 blockedBy 反向，所有依赖它的步骤一并作废。
4. 重算 frontier = { 所有 blockedBy 全部 ok 且自身无有效 ok 记录的步骤 }。
5. 消费 answers.jsonl：已回答的 blocker 注入对应步骤的输入，关闭 blockers/<id>.json。
6. 继续调度。有效 ok 的步骤永不重跑，零 agent 调用。
```

**3.b 是必须的，也是最容易漏的一条。** ledger 记录的是"agent 说了什么"，**不是它在文件系统和 git 上造成的结果**。那部分是步骤的真实产出却不在台账里。如果恢复时 HEAD 已经变了（有人 push 了、上一次 run 被回滚了、另一个 run 动过），把旧答案当有效，run 会在错误基线上继续——**这种错不报错，只产出错的东西**。所以写仓步骤必须钉 SHA 并在恢复时校验。

### 4.4 预算按计划计，不按尝试计

现有 `controller.ts` 的 `MAX_AGENT_CALLS = 32` 与 `sandbox.ts` 的 `MAX_AGENT_REQUESTS = 32` 是**单次 run 内计数**。恢复会立刻把预算打爆。

规则：

- 预算计数只累加**实际发起的 agent 调用**（ledger 命中跳过的不计）。
- 计数**跨恢复持久化**在 `run.json.budgetUsed`。
- 重试消耗预算（否则无限重试可绕过预算），但按 `retry.maxAttempts` 封顶。
- 单步可声明 `budget.agentCalls` 子预算；所有子预算之和不得超过计划预算（校验 V6）。

## 5. 失败分类、重试与限流治理（G2）

### 5.1 错误分类是前置条件

现状：`runner.ts` 的 `AgentOutcome` 只有 `error?: string`，把 429、provider 5xx、逻辑错误、闸门不过**全部拍平成一个字符串**。在这个基础上无法做正确重试。必须先加分类：

```ts
type FailureClass =
  | "rate_limit"            // 429，可能带 retry-after
  | "overloaded"            // 529 / provider 过载
  | "provider_error"        // 5xx、连接中断
  | "first_response_stall"  // 触发 FIRST_RESPONSE_TIMEOUT_MS
  | "tool_timeout"          // 单工具调用超时
  | "context_exhausted"     // 上下文打满
  | "aborted"
  | "agent_error"           // 模型自身把任务做失败了
  | "no_structured_output"
  | "internal";

interface FailureInfo {
  class: FailureClass;
  message: string;
  retryAfterMs?: number;
  provider?: string;
  model?: string;
}
```

分类来源：`AgentSession` 的 `msg.errorMessage` / `stopReason`（`runner.ts` 已收集）+ provider HTTP 状态与 `retry-after` 头。**若 SDK 当前不暴露状态码，这是一个阻塞点，需先确认**（见 §14 未决问题 Q1）。

### 5.2 重试策略

```ts
interface RetryPolicy {
  maxAttempts: number;        // 默认 4
  baseMs: number;             // 默认 2000
  maxMs: number;              // 默认 120000
  jitter: true;               // 必须有抖动
  retryOn: FailureClass[];    // 默认 rate_limit / overloaded / provider_error / first_response_stall / tool_timeout
}
```

- 退避：`min(maxMs, baseMs * 2^(attempt-1))` + 随机抖动。
- `rate_limit` 带 `retryAfterMs` 时以它为下界。
- **不重试**：`agent_error`、`no_structured_output`、`context_exhausted`、`aborted`、预算耗尽。这些走闸门/升级路径，不是抖动。
- `maxAttempts` 耗尽后：步骤记 `failed`，run **不立即失败**——转 `suspended` 并记录 `resumeAfter`，保住其余已完成进度。这正是"模型服务异常后还能接着执行"的语义。

### 5.3 限流治理（全局降速）

单步退避不够：并发 4 个子 agent 同时撞 429，各自退避等于继续打爆配额。

引入 **RateLimitGovernor**（run 级，未来可升级为跨 run 级）：

- 任一子 agent 报 `rate_limit`/`overloaded` → 设 `run.throttleUntil = now + retryAfter`，run 状态转 `throttled`，**暂停所有新步骤调度**（在途步骤自然结束）。
- `throttleUntil` 到点后恢复 `running`，并把并发临时降为 1，连续两步成功再逐级回升到计划并发（加性增、乘性减）。
- `throttleUntil` 写 `run.json`，进程重启后仍然生效。
- 仪表盘显示节流剩余时间与当前有效并发。

### 5.4 闸门失败 ≠ transient

`gate-failed` 走独立路径：按 `policy.onGateFail`，

- `repair-once`：把 `predicates` 的 `message` 与 schema 校验错回灌给**同一个步骤**，做一次且仅一次修复尝试；仍不过 → 按步骤 `escalation` 升级。
- `escalate`：直接升级。

修复尝试消耗预算、写 ledger（`attempt+1`），不触发退避等待。

## 6. Run 状态机

```
                ┌──────────┐
                │ pending  │
                └────┬─────┘
                     ▼
   ┌──── throttled ⇄ running ⇄ awaiting-parent ────┐   (inline 步骤等主会话回报)
   │                   │  ▲                         │
   │                   │  └──── awaiting-input ◀────┘   (L3 blocker，等人)
   │                   ▼
   │            ┌──────────────┐
   └──────────▶ │  suspended   │  (进程死亡/重试耗尽；可恢复)
                └──────┬───────┘
                       ▼
      completed │ failed │ replan-required │ aborted
```

四个终态的区别要写进仪表盘文案：

- `completed` —— 全部步骤 ok 且闸门通过。
- `failed` —— 不可恢复（计划哈希不符、预算耗尽且无法升级）。
- `replan-required` —— 执行中发现**计划本身错了**（规格自相矛盾、某步需要超出 `maxEscalation` 的人类介入）。产出 `replan.json { reason, conflictingEvidence, suggestedClarifications[] }`。这比挂起等答案有用：问题不在某个答案上。
- `aborted` —— 人为终止。

`suspended` 与 `awaiting-input` **不是一回事**：前者等 runner，后者等人。仪表盘必须分开显示，否则"等你"的 run 会被当成"还在跑"而无人理。

## 7. 升级策略（三级 + replan）

执行期不存在"问用户"，只存在三级升级。每步声明它**最高允许到哪级**，超出即 `replan-required`。

| 级别 | 行为 | 适用 |
| --- | --- | --- |
| **L1 假设前进** | 写 `assumptions.jsonl`，继续；必须出现在最终 handoff | implement 的绝大多数判断 |
| **L2 报告标记** | 写入步骤产物 `flags[]`，不挡路 | code-review 的发现 |
| **L3 挂起** | 写 `blockers/<id>.json`，run → `awaiting-input`，通知，干净退出 | 拿不到的事实、必须人做的外部动作、两个分支都丢行为的决定 |

方法论依据：`procedures/diagnosing-bugs.md:97`（"Don't block on it — proceed with your ranking if the user is AFK"）、`procedures/wayfinder.md:103`（"until the frontier requires human input"）。

L1 记录格式：

```ts
interface Assumption {
  stepId: string;
  question: string;       // 本来要问什么
  assumption: string;     // 实际按什么假设走的
  evidence?: string;
  reversible: boolean;    // 不可逆的假设在 handoff 里单独置顶
}
```

L3 的 blocker 复用 pi-packages `CONTEXT.md` 已定义的 **Attention Request** 形状，不新造词汇：

```ts
interface Blocker {
  id: string;
  stepId: string;
  decision: string;           // 要决定什么
  evidence: string;           // 支撑材料
  recommendation: string;     // 引擎的建议（必填，不准甩空问题）
  choices: string[];          // 允许的选项
  openedAt: number;
  notified: { channel: string; at: number; ok: boolean }[];
}
```

**`notified` 里没有一条成功的送达，就不算有效挂起。** detached 运行必须配 `policy.notify`（校验 V10）；否则 run 会静默吊死——这是比崩溃更糟的失败模式。

回答经 `workflow_answer` 写 `answers.jsonl`（`status: "answered"`），恢复时消费。

## 8. Methodology Provider 接口（matt-pocock 怎么适配进来）

```ts
interface MethodologyProvider {
  id: string;
  version: string;
  catalogHash: string;                     // 进 plan.provider，用于检测 provider 漂移

  listProcedures(): ProcedureMeta[];
  loadBrief(procedureId: string, ctx: BriefContext): Promise<string>;
  gateFor(procedureId: string): Gate | undefined;
  validateEdge(from: string, to: string): boolean;
  suggestPlan?(task: TaskStatement): PlanDraft;   // 可选：provider 侧计划草案
}

interface ProcedureMeta {
  id: string;
  kind: "workflow" | "reference" | "utility" | "asset";
  phases: string[];
  allowedNext: string[];
  requires: string[];
  discloses: string[];
  standalone: boolean;
  defaultStepKind?: StepKind;     // 建议值，计划可覆盖
  defaultEffects?: Step["effects"];
  maxEscalation?: 1 | 2 | 3;
}
```

### 8.1 matt-pocock 适配映射

| provider 方法 | matt-pocock 来源 |
| --- | --- |
| `listProcedures` | `packages/matt-pocock/src/catalog.json`（`kind` / `workflows[].phase` / `allowedNext` / `requires` / `discloses` / `standalone`） |
| `validateEdge` | `src/catalog.ts` 的 `allowedTransitions`，即 `src/workflow.ts:60` `transitionState` 今天在运行时做的检查——**前移到计划校验期** |
| `loadBrief` | `src/resolver.ts` 的依赖闭包 + `<procedure-source>` 包装 + 64 KiB 上限，原样复用 |
| `gateFor` | `procedures/*-FORMAT.md` 对应的 JSON Schema（**新增** `packages/matt-pocock/schemas/*.json`） |
| `defaultStepKind` / `maxEscalation` | **新增**：catalog 里每个 procedure 的可选字段；缺省由适配器给保守默认（`serial` / L1） |

### 8.2 关键结果：`allowedNext` 从运行时 guard 变成计划类型系统

今天 `transitionState` 只**拒绝**非法迁移，从不**驱动**迁移——它是 guard 不是 scheduler，这就是不确定性的根源。v2 里它成为 `validateEdge`，在计划准入时检查；**非法迁移在执行产物里根本不存在**。

### 8.3 集成方式：先 A，后 B

- **方案 A（v1 采用）**：适配器直接读已安装的 `pi-matt-pocock` 包目录（解析 `catalog.json`、读 `procedures/*.md`）。除新增 `schemas/` 外，matt-pocock **零改动**，无需跨仓发版协调。耦合点是包的文件布局，用 `catalogHash` 检测漂移。
- **方案 B（后续）**：matt-pocock 导出 `provider.json` 清单 + schemas 作为公开数据契约，适配器按契约消费，不再依赖目录结构。

## 9. 工具与命令表面

| 名称 | 类型 | 作用 |
| --- | --- | --- |
| `workflow_plan` | tool | 按 task + provider 合成计划，跑校验，返回计划与校验报告。**不执行。** |
| `workflow_run` | tool | 运行计划（`planId` 或内联 plan），`mode: "foreground" \| "detached"` |
| `workflow_report` | tool | 主会话回报 `inline` 步骤产物（驱动 `awaiting-parent` → `running`） |
| `workflow_answer` | tool | 回答 blocker（也可从 `/workflows` UI 走） |
| `workflow` | tool | **保留**旧签名（`script` / `args` / `background`），等价于单 `script` 步骤的计划 |
| `/workflows` | command | 仪表盘：run 列表、DAG 视图、ledger、blockers（"等你"）、assumptions、节流状态、恢复入口 |

`workflow` 旧工具上的硬闸门（`prompt.ts:20` "only to be called when the user says 'ultracode'"）对 v2 不适用：`workflow_run` 的准入由"计划已批准"决定，不由口令决定。

## 10. 计划准入校验（V1–V10）

这些是"避免不确定性"的牙齿。每条都要有一个失败计划 fixture。

| # | 规则 |
| --- | --- |
| V1 | 每个 `step.procedure` 在 provider 中存在 |
| V2 | 每条 `blockedBy` 边对应的 procedure 迁移经 `validateEdge` 合法 |
| V3 | DAG 无环；无孤立步骤；存在至少一个无前驱的根 |
| V4 | 每个 `mode: "AFK"` 步骤必须有 `gate` |
| V5 | `step.escalation ≤ policy.maxEscalation`；`escalation === 3` 要求 `policy.blockable === true` |
| V6 | `Σ step.budget.agentCalls ≤ plan.budget.agentCalls ≤ 引擎上限`；`plan.budget.concurrency ≤ 引擎上限` |
| V7 | `mode: "detached"` 的运行：计划不得含 `kind: "inline"` 步骤，不得含 `mode: "HITL"` 步骤 |
| V8 | `effects: "repo"` 的步骤必须声明 `task.branch`；**任意时刻最多一个写仓步骤在途**；并发的写步骤必须各自 `effects: "worktree"` 并分配独立 worktree |
| V9 | detached 运行要求 `approval.planHash` 等于重算值 |
| V10 | `policy.blockable === true` 的 detached 运行必须配置至少一个 `policy.notify` 渠道 |

**V8 同时暴露现有代码的一个活 bug**：`index.ts` 用 `createWorkflowResources(ctx.cwd, ...)` 给所有子 agent，即**全部子 agent 共享父进程 cwd**，而并发上限是 4。只读扇出没问题，**可写扇出会互相踩工作区**。v2 必须强制：并发的写步骤走独立 worktree。

## 11. 可观测性（"过程看得见"）

- 每条 ledger 记录 = 仪表盘一行：步骤、尝试次数、状态、耗时、成本、模型。
- `/workflows <runId>` 显示 DAG：每步状态、为什么在等（等人 / 等 runner / 被节流 / 等主会话）。
- 所有状态从**磁盘**读（`run.json` + `ledger.jsonl`），不只从内存 Map。现有 `listRuns`（`index.ts:171`）已经半边如此；v2 要求全部如此——这同时是 N1（未来 supervisor 接管）的前置条件。
- `assumptions.jsonl` 在 run 结束时汇总进 handoff，不可逆假设置顶。

## 12. 对现有代码的改动清单

| 位置 | 改动 |
| --- | --- |
| `runner.ts` `AgentOutcome` | 加 `failure: FailureInfo`；错误分类（§5.1）。**所有重试逻辑的前置条件** |
| `runner.ts` `SessionManager.inMemory(options.cwd)` | 换成持久化 SessionManager；同仓已有先例 `extensions/subagents/src/backends/pi.ts:290` 的 `SessionManager.create(task.cwd)`。顺带可借用 `extensions/subagents/src/ui/takeover.ts` 实现子 agent 接管 |
| `runner.ts` `FIRST_RESPONSE_TIMEOUT_MS`（45s）、工具 3 分钟超时 | 支持按步骤覆盖；跑测试的 implement 步骤必然顶满默认值 |
| `sandbox.ts` `onAgent` | 包一层 ledger 查表：命中直接返回，未命中才真跑。约 40 行 |
| `sandbox.ts` `MAX_AGENT_REQUESTS` / `controller.ts` `MAX_AGENT_CALLS` | 由"单次 run 计数"改为"计划级预算 + 跨恢复持久化"（§4.4） |
| `controller.ts` `Semaphore` | 接入 RateLimitGovernor：可动态调并发、可被 `throttleUntil` 暂停 |
| `model.ts` `WorkflowStatus` | 加 `throttled` / `suspended` / `awaiting-input` / `awaiting-parent` / `replan-required`；`statusSquare` / `statusWord` / `statusColor` 各加分支 |
| `index.ts:395` `background = (params.background ?? false) && ctx.hasUI` | 加 headless 执行路径：`mode: "detached"` 不依赖 `hasUI` |
| `index.ts:294` `session_shutdown` 全量 abort | detached run 改为**落盘后脱离**而非 abort；会话结束不杀 detached run（本版最小实现：落盘 + 下次会话可恢复；常驻 supervisor 属 N1） |
| `artifacts.ts` | 新增 ledger / blockers / assumptions 的原子追加写；复用现有 `writeFileAtomic` 与节流 checkpoint |
| `prompt.ts` | 重写工具描述；移除 "ultracode" 口令闸门；新增 plan/report/answer 的模型面文档 |

## 13. 里程碑与验收测试

每个里程碑独立可用、独立可测，顺序按"本版优先级"排。

| M | 内容 | 验收 |
| --- | --- | --- |
| **M1** | 错误分类 + 重试 + RateLimitGovernor | 注入前两次 `provider_error`：步骤在第 3 次成功，ledger 有 3 条记录（2 failed / 1 ok）。注入带 `retry-after` 的 429：run 转 `throttled`，期间不发起任何新步骤，到点后并发从 1 逐级回升 |
| **M2** | Ledger + 恢复 | 5 步计划在第 3 步杀进程；恢复后只跑 3–5 步，步骤 1–2 的 agent 调用数为 0；`budgetUsed` 跨恢复累计正确 |
| **M3** | git SHA 钉住与传递作废 | 恢复前外部改动 HEAD：`effects != readonly` 的步骤被作废，其下游亦被作废；`readonly` 步骤保留 |
| **M4** | L1/L2/L3 + 通知送达 + 回答消费 | AFK run 触发 L3：状态 `awaiting-input`，blocker 文件完整（含 recommendation 与 choices），通知送达被记录；`workflow_answer` 后恢复并越过该步 |
| **M5** | Plan IR + 校验器 | V1–V10 各有一个失败 fixture 被拒绝，并给出可读原因；合法计划通过 |
| **M6** | matt-pocock provider 适配器（方案 A）+ 闸门 schema | **单张 AFK ticket 端到端**：澄清 → 一份 agent brief → implement → code-review → handoff，全程零 ask，闸门生效 |
| **M7** | `inline` 步骤 + `workflow_report` | 含 `inline` 步骤的计划在主会话执行该步并保留原文；V7 拒绝其 detached 运行 |
| **M8** | 仪表盘：DAG / ledger / 等你 / 节流 / 恢复入口 | `suspended` 与 `awaiting-input` 文案与排序可区分；从仪表盘可直接恢复 |
| **M9** | frontier 走子（多步 DAG 并发调度） | 并发写步骤被强制分配独立 worktree；写仓步骤串行 |

**M6 之前不要去走 DAG。** 先用单张 ticket 把 ledger / 升级 / 恢复这条循环跑通，`frontier` 调度（`procedures/to-tickets.md:57`、`procedures/wayfinder.md:99` 描述的那个循环）放到 M9。

## 14. 未决问题（需审阅决策）

- **Q1（阻塞 M1）**：`@earendil-works/pi-coding-agent` 的 `AgentSession` 是否暴露 provider HTTP 状态码与 `retry-after`？若只有 `errorMessage` 字符串，`rate_limit` 只能靠文本匹配识别——可接受的临时方案，但要确认 SDK 是否有更好的出口。
- **Q2**：计划合成由谁做？（a）主会话模型按 provider 的 `listProcedures` 自己拼；（b）provider 的 `suggestPlan` 给草案、模型补 brief。倾向 (a) 起步，(b) 作为 matt-pocock 侧增强。
- **Q3**：`workItemId` 与 matt-pocock 现有会话态（`src/workflow.ts` 的 `WORKFLOW_STATE_ENTRY`）如何对齐？是 v2 run 反向写回 matt-pocock 的状态记录，还是二者共用 `workItemId` 但各记各的？倾向后者（低耦合），但 `/matt-pocock` 菜单里需要能看到关联的 run。
- **Q4**：detached run 在本版是否真的要脱离会话？最小可行是"会话结束前落盘，下次会话手动/自动恢复"，完整脱离需要常驻 supervisor（N1）。倾向最小可行。
- **Q5**：`gate.verify` 允许执行仓内命令，这是计划里的一个代码执行面。是否限制为白名单（`package.json` scripts）而非任意 shell？倾向限制。
- **Q6**：闸门谓词小语言的算子集是否够用？现在给了 8 个，宁可窄开始。
- **Q7**：`script` 逃生口是否保留？保留则旧能力不丢，但模型可能绕过计划直接写 JS。倾向保留但仅限 `mode: "foreground"`。

## 15. 设计不变量（实现时不得破坏）

1. `ledger.jsonl` / `answers.jsonl` 只追加，永不改写。
2. 引擎不 import 任何 provider 专有概念；provider 只被只读查询。
3. 未批准（`planHash` 不符）的计划不得 detached 运行。
4. 有效 `ok` 的 ledger 条目永不重跑。
5. 写仓步骤的 ledger 条目必须钉 `headSha`，恢复时必须校验。
6. 执行期不存在"问用户"，只存在 L1/L2/L3 与 `replan-required`。
7. 没有一条成功送达记录的 L3 不算有效挂起。
8. 全部 run 状态可由外部进程仅凭磁盘读取重建（为 N1 留门）。
