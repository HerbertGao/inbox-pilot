# ③A 双向回归 eval

证明收紧分类 prompt（`rating-calibration-prompt`）**没有放过真钓鱼**。机制定案见
`openspec/changes/rating-calibration-prompt/design.md`「守门机制」节。

## 为什么需要它

prompt 收紧（P4 从「任何疑似」收窄到「需内容层欺骗证据」）若过头会让**真钓鱼掉出 P4 = 安全回归**。
唯一安全网是真调模型跑双向语料：真钓鱼**必须仍 P4**、误报**应**降出 P0/P4。本仓离线测全用假
`chatSpy`、测不了真实 prompt，故本 eval 必须真调 OpenRouter。

## 二象限矩阵（语料价值由象限B 决定，非总条数）

|  | 表层信号强 | 表层信号弱 |
|---|---|---|
| **内容欺骗强** | 象限A 教科书钓鱼（合成、配额 **≤30%**） | **象限B 守门全部价值（真脱敏、≥50%）** |
| **内容欺骗弱** | 象限C 自有转发域假阳性（→ 误报集） | 象限D 正常通知/收据（→ 误报集） |

- **象限A** 收紧前后都该 P4、信息量最低 → 封顶 ≤30% 防虚假安全感。
- **象限B**（表层正常、内容欺骗隐晦）是收紧后唯一靠「内容欺骗证据」托底的那类 = 守门价值所在。
  **必须真脱敏**——合成/LLM 生成会系统性偏到象限A、写不出象限B。

## 判定协议

- **真钓鱼安全线**（`pnpm eval:phishing`，PR 阻塞）：逐样本 **k=5 多数表决**，某样例 **<3/5 落 P4 即 FAIL**。
  区分单次抖动（噪音）vs 系统性误伤（信号）；**不**用失败重试（统计有偏）。
- **误报噪音线**（`pnpm eval:false-positive`，nightly 非阻塞）：k=1，通过率 **<70% 即 FAIL**。
- **缺 `OPENROUTER_API_KEY`**（fork PR / 本地未配）→ **skip 标绿**、不阻塞。

## 用户前置动作（守门实装所需）

1. **加 secret**：仓库 Settings → Secrets and variables → Actions → 新增 `OPENROUTER_API_KEY`
   （建议单建一把带花费上限/可吊销的 CI key，别复用生产）。
2. **补象限B 真语料**：编辑 `corpus.ts` 的 `PHISHING_QUADRANT_B`，填 **≥6 条**真脱敏样例。
   录入准则：① 只动 PII、保语用结构；② 链接全写 `hxxp://placeholder.example`（断活性）；
   ③ 压测剔伪装（「删掉所有表层异常后仅凭正文人类仍能判钓鱼吗？」答否者剔除）；
   ④ 覆盖中文 5 类：仿冒银行/支付催缴 · HR/offer · 同事上级转账 · 账号续费 · 物流补缴。
   象限B 为空时 runner 会 WARN「守门未实装」。

## 运行

```bash
# 本地（需 DATABASE_URL 占位 + 真 key 才真跑；缺 key 会 skip）
DATABASE_URL=postgresql://x:x@localhost:5432/x OPENROUTER_API_KEY=<key> pnpm eval:phishing
DATABASE_URL=postgresql://x:x@localhost:5432/x OPENROUTER_API_KEY=<key> pnpm eval:false-positive
```

CI 见 `.github/workflows/eval.yml`（phishing 仅在动 prompt/classifier/eval 的 PR 触发、false-positive nightly）。

> **分支保护注**：要让 `phishing-gate` 真正阻塞合并，在分支保护里设为 required check。注意 paths 过滤——
> 不动 prompt/classifier/eval 的 PR 不触发本 workflow；按 GitHub 行为这类 PR 的该 check 视为「未要求」而非 pending
> （若你的配置把它卡成 pending，改用「always-run gate job」模式，本期不预建——YAGNI）。
>
> **eval 与离线测分离**：本目录文件**不带 `.test.ts`**，故不被 `pnpm test`（glob `src/**/*.test.ts`）收集——
> 真调模型只在 `pnpm eval:*` / eval.yml 跑，日常 CI 与离线测零污染。
