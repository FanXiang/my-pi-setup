# 在 Pi 里验证 Workflow v2（M1–M4）

配套文档：[`conductor-handoff.zh-CN.md`](conductor-handoff.zh-CN.md)（交接）、[`conductor-spec.zh-CN.md`](conductor-spec.zh-CN.md)（设计契约）。

本文件覆盖**单测覆盖不到的那一层**：工具层集成（`resume`、`block` 挂起 → `workflow_answer` → 恢复、git 钉住、仪表盘状态）。单测已覆盖的契约层不在此重复。

---

## 0. 准备：用隔离的 agent 目录，不要动你的线上设置

这套扩展从 `~/.pi/agent` 加载（见 `SETUP.md`），所以在那里切分支会直接改变你的**线上** Pi 环境。SDK 支持用环境变量换掉 agent 目录（`pi-coding-agent/dist/config.js` 的 `ENV_AGENT_DIR`），用它隔离：

```sh
# 1. 准备隔离的 agent 目录
git clone -b claude/beautiful-shannon-wr1ndr <你的 my-pi-setup remote> ~/pi-test-agent
cd ~/pi-test-agent && npm install

# 2. 把凭证与模型表带过去（否则要重新登录）
cp ~/.pi/agent/auth.json     ~/pi-test-agent/ 2>/dev/null
cp ~/.pi/agent/models.json   ~/pi-test-agent/ 2>/dev/null
cp ~/.pi/agent/settings.json ~/pi-test-agent/ 2>/dev/null

# 3. 准备一个一次性 git 仓库当工作目录（S3 会改动它）
mkdir -p /tmp/wf-probe && cd /tmp/wf-probe && git init -q
git config user.email t@e.com && git config user.name T
echo hello > a.txt && git add -A && git commit -qm init

# 4. 启动
PI_CODING_AGENT_DIR=~/pi-test-agent pi
```

若你接受直接在线上测：`cd ~/.pi/agent && git fetch origin claude/beautiful-shannon-wr1ndr && git checkout claude/beautiful-shannon-wr1ndr && npm install`，重启 pi。测完 `git checkout main` 回去。

**run 产物目录**（下面统称 `$RUNS`）：`$PI_CODING_AGENT_DIR/workflows/`，默认 `~/.pi/agent/workflows/`。

### 0.1 冒烟检查

启动后在 Pi 里输入 `/workflows`。若命令不存在，扩展没加载成功（通常是 `npm install` 没跑或 Node 版本不符，仓库目标 Node 26）。

### 0.2 两件必须先知道的事

1. **工具有口令闸门。** `prompt.ts:20` 写着只有用户说 `ultracode` 或明确要求跑 workflow 时才调用。所以每个提示都以 **`ultracode`** 开头。（移除这道闸门在规格的改动清单里，尚未做。）
2. **前台 run 非 `completed` 结束时，工具是 `throw` 出去的**（`index.ts:1189`，注释说明 Pi 只在 execute 抛出时标记失败）。所以 `awaiting-input` 在前台会显示成**工具失败**，正文是完整的 blocker 文本。
   - ⚠️ **模型看到工具失败的自然反应是重试**，而重试若不带 `resume` 会开一个**新 run、新 blocker**，空耗模型调用。测 `block` 时请用 `background: true`（后台 run 走 follow-up 消息而非抛出），并在模型想重试时叫停。
   - 这是 M4 暴露出的一个待决设计问题，见本文末"已知待决"。

---

## 正文：七个场景

每个场景给出：**在 Pi 里说什么** → **应当看到什么** → **在磁盘上核对什么**。

脚本请要求模型**原文照传**。恢复时用 `$RUNS/<runId>/script.js` 里持久化的原文，避免模型改写导致哈希不符。

---

## S1 · 失败分类与模型名校验（M1）

> `ultracode` 跑一个 workflow，脚本原文照传不要改：
>
> ```js
> export const meta = { name: 'probe-badmodel', description: 'failure classification', phases: [{ title: 'One' }] }
> phase('One')
> const r = await agent('Reply with exactly: ONE', { label: 'bad', model: 'nope/not-a-real-model' })
> return { ok: r.ok, error: r.error }
> ```

**应当看到**：`agent "bad": unknown model "nope/not-a-real-model" (use provider/id)`，run 正常结束。

**核对**：`cat $RUNS/<runId>/ledger.jsonl` —— **应当为空或不存在**。模型解析现在发生在 `controller.schedule` 之前，非法模型名不再消耗预算，也不写台账。

```sh
cat $RUNS/<runId>/workflow.json | python3 -m json.tool | grep -A5 throttle
```
应能看到 `throttle` 快照字段（`concurrency`/`limit`/`throttles`），证明治理器已接线。

**限流治理本身无法按需触发**（需要真 429）。它由单测覆盖；在 Pi 里是机会性验证：真撞上限流时，工具块会出现 `throttled Ns · concurrency 1/4`，且期间不再启动新 agent。

---

## S2 · 台账与恢复（M2）⭐ 最核心

> `ultracode` 跑一个 workflow，脚本原文照传不要改：
>
> ```js
> export const meta = { name: 'probe-ledger', description: 'resume check', phases: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }] }
> phase('One'); const a = await agent('Reply with exactly: ONE', { label: 'one' })
> phase('Two');  const b = await agent('Reply with exactly: TWO', { label: 'two' })
> phase('Three'); const c = await agent('Reply with exactly: THREE', { label: 'three' })
> return { a: a.output, b: b.output, c: c.output }
> ```

**第一步：让它中途死掉。** 在第二个 agent 还在跑时按 **Esc**（前台 run 绑在当轮的 abort 信号上）。

**核对**：
```sh
RUN=$RUNS/wf_xxxxxx
wc -l $RUN/ledger.jsonl                      # 期望 2 行：一条 ok，一条 failed(aborted)
python3 -c "import json,sys; [print(json.loads(l)['seq'], json.loads(l)['status'], json.loads(l)['label']) for l in open('$RUN/ledger.jsonl')]"
grep -o '"budgetUsed":[0-9]*' $RUN/workflow.json
```

**第二步：恢复。** 拿到原文脚本再跑：
```sh
cat $RUN/script.js
```
> `ultracode` 用 `resume` 参数恢复 run `wf_xxxxxx`，脚本原文照传（粘贴上面 cat 的内容）

**应当看到**：
- 工具块摘要含 **`(1 reused)`**
- 结果消息含 **`1 reused from the ledger`** 和 **`Attempt 2 (resumed); N agent call(s) charged in total`**
- 第一步那个 agent **瞬间完成**（零模型调用）

**核对**：`wc -l $RUN/ledger.jsonl` 现在是 4 行（2 旧 + 2 新）；`budgetUsed` 累计到 4。

**第三步：再恢复一次。** 同样的命令再跑。应当 **`3 reused`**、零新调用、几乎瞬间返回。

**附带验证守卫**：改一个字再带 `resume` 跑 → 应当被拒：`the script differs from the one it recorded. Start a new run instead.`

---

## S3 · git 钉住与传递作废（M3 核心）

必须在一次性 git 仓库里跑（准备步骤 3）。

> `ultracode` 跑一个 workflow，脚本原文照传：
>
> ```js
> export const meta = { name: 'probe-git', description: 'worktree pinning', phases: [{ title: 'Write' }] }
> phase('Write')
> const w = await agent('Create a file named probe.txt containing the single word PROBE in the current directory. Then reply with exactly: DONE', { label: 'writer' })
> return { ok: w.ok }
> ```

**核对**：
```sh
python3 -c "import json; e=[json.loads(l) for l in open('$RUN/ledger.jsonl')][0]; print('before',e['before']); print('after',e['after'])"
```
`before.clean` 应为 `true`，`after.clean` 应为 `false` —— 工作区被弄脏了，所以这条被钉住。

**第一步：原地恢复**（`probe.txt` 还在、未提交）→ 应当 **`1 reused`**。当前树状态与记录的 `after` 一致。

**第二步：提交后恢复**：
```sh
git add -A && git commit -qm "probe"
```
再恢复 → 应当看到 **`1 recorded call(s) were invalidated because the worktree moved, and ran again.`**，agent 真的重跑了。

**注意一个刻意的保守行为**：一旦工作区变脏，**其后的调用也会被钉住**——无法证明它们没写东西。所以"脏树里的只读调用"也会被重跑。这是安全方向（判错只是多跑），规格 §4.1.1 已记录。

---

## S4 · 假设与标记（M4 L1/L2）

> `ultracode` 跑一个 workflow，脚本原文照传：
>
> ```js
> export const meta = { name: 'probe-escalate', description: 'assume and flag', phases: [{ title: 'Work' }] }
> phase('Work')
> assume({ question: 'Which timezone should timestamps use?', assumption: 'UTC', evidence: 'no config found' })
> assume({ question: 'Retry count?', assumption: '3', reversible: true })
> flag({ note: 'the retry loop has no test' })
> flag('bare note form also works')
> return 'done'
> ```

**应当看到**结果消息里：
```
Assumptions (2):
- [irreversible] Which timezone should timestamps use? → UTC
- Retry count? → 3
Flags (2):
- the retry loop has no test
- bare note form also works
```
不可逆的排在前面（这是刻意的排序）。

**核对**：`cat $RUN/assumptions.jsonl $RUN/flags.jsonl`

**顺带验校验**：把一条改成 `assume({ question: 'q' })`（缺 `assumption`）→ 整个 run 应当失败并报 `assume() \`assumption\` is required`。契约在边界强制，不允许半记录。

---

## S5 · 挂起 → 回答 → 恢复（M4 L3）⭐ 头牌流程

**用后台模式跑**，避免 0.2 节那个"挂起显示成工具失败"的问题。

> `ultracode` 用 `background: true` 跑一个 workflow，脚本原文照传：
>
> ```js
> export const meta = { name: 'probe-block', description: 'attention request', phases: [{ title: 'Decide' }] }
> phase('Decide')
> const answer = await block({
>   decision: 'Which greeting should the reply use?',
>   evidence: 'Neither is referenced anywhere in the repo.',
>   recommendation: 'hello, it matches the existing copy',
>   choices: ['hello', 'hi'],
> })
> const r = await agent('Reply with exactly: ' + answer.choice, { label: 'greet' })
> return { choice: answer.choice, output: r.output }
> ```

**应当看到**：
- 编辑器下方指示器出现 **`■ 1 needs you`**（不是 `failed`）
- 后台 follow-up 消息含完整 blocker 文本：decision / Evidence / Recommendation / 编号的 choices / `workflow_answer runId=... blockerId=...`
- `/workflows` 里这一条状态是 **`needs you`**

**核对**：
```sh
cat $RUN/NEEDS-INPUT.md
ls $RUN/blockers/
python3 -c "import json,glob; b=json.load(open(glob.glob('$RUN/blockers/*.json')[0])); print(b['notified'])"
```
`notified` 应当有两条 `ok: true`（file + ui 两个通道各一条）。**这是"送达被记录"的验收点。**

**先验一下拒绝非法选项**：
> 用 `workflow_answer` 回答 run `wf_xxx` 的 blocker `<id>`，choice 填 `maybe`

应当被拒并列出合法选项：`"maybe" is not one of this blocker's choices: hello | hi`

**然后正式回答**：
> 用 `workflow_answer` 回答 run `wf_xxx` 的 blocker `<id>`，choice 填 `hi`

**应当看到**：`Recorded "hi" for blocker ...` + `Resume the run to continue past it`。`NEEDS-INPUT.md` 被删除（无未答 blocker 了）。

**最后恢复**：
> `ultracode` 用 `resume` 恢复 run `wf_xxx`，脚本原文照传

**应当看到**：`block()` **不再挂起**，直接返回 `hi`，后面的 agent 跑起来，最终结果 `{ choice: 'hi', output: 'hi' }`。

**核对**：`cat $RUN/answers.jsonl` 有一行；run 状态变成 `completed`。

---

## S6 · replan（M4 第四种终态）

> `ultracode` 跑一个 workflow，脚本原文照传：
>
> ```js
> export const meta = { name: 'probe-replan', description: 'wrong plan', phases: [{ title: 'Check' }] }
> phase('Check')
> replan({
>   reason: 'The spec requires both fail-fast and retry-forever on the same step.',
>   conflictingEvidence: 'spec lines 12 and 48',
>   suggestedClarifications: ['Which wins when both apply?'],
> })
> await new Promise(() => {})
> ```

**应当看到**：run 以 **`needs replanning`** 结束（不是 failed），消息含 `Replanning needed: ...`、`Conflicting evidence: ...`、`Suggested clarifications:`。

**核对**：`cat $RUN/replan.json`

---

## S7 · 仪表盘与陈旧 run 回收

做完上面几个场景后，输入 `/workflows`。

**应当看到**四种状态能互相区分：`done` / `needs you` / `needs replanning` / `aborted`。**重点：`needs you` 不得显示成 `failed`** —— 两者要求的反应相反。

**再验一条回归**：把 Pi 关掉再开，`/workflows` 重新读磁盘。
- `awaiting-input` / `replan-required` 的 run **必须保持原状态**（它们正停在该停的地方，且可恢复）
- `running` / `throttled` 的 run 才会被回收成 `aborted`

这一条先前是个 bug：状态收窄里漏掉分支会让死掉的 run 显示成 `completed`（`dashboard.ts` 现在用 `isLiveStatus()` 统一判断）。

---

## 成本与清理

每个场景 1–3 次平凡模型调用。想更省可以在 `agent()` 里指定便宜模型：`{ model: 'provider/id' }`。

```sh
rm -rf $RUNS/wf_*            # 清掉探针 run
rm -rf /tmp/wf-probe         # 清掉一次性仓库
# 若用了隔离目录：rm -rf ~/pi-test-agent
```

---

## 已知待决（测试会撞上的）

1. **前台挂起显示成工具失败**（`index.ts:1189`）。`awaiting-input` 和 `replan-required` 是**结果**，不是错误，而抛出会把模型推向"重试"，重试不带 `resume` 就是新 run + 新 blocker + 白花钱。
   **建议**：这两个状态改为正常返回（消息已经足够清楚，且 run 状态本身就是 `needs you`），`failed` / `aborted` 继续抛。**尚未改动**——需要决定后再动，因为它改变模型侧的可见行为。
2. **口令闸门** `prompt.ts:20` 的 "ultracode" 与"让 procedure 指示模型调用 workflow"冲突，规格里计划移除，尚未做。
3. **`assume`/`flag`/`block` 只对编排脚本可见**，子 agent 不能自行升级（刻意，规格 §7）。所以测试时这些调用要写在脚本里，不能指望子 agent 自己发起。
4. **端到端仍无自动化测试**。本文件就是人工替代品；若某个场景要固化成回归测试，需要一个能起真实 Pi 运行时的测试宿主。
