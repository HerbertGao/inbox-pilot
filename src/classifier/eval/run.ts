// ③A 双向回归 eval runner（rating-calibration-prompt / design「守门机制」决策 2-6）。
//
// 用法：tsx src/classifier/eval/run.ts --suite phishing|false-positive
//   - phishing（安全线）：逐样本 k=5 多数表决，某样例 <3/5 落 P4 即 FAIL → exit 1。
//   - false-positive（噪音线）：k=1，通过率 <Y=70% 即 FAIL → exit 1。
//   - 缺 OPENROUTER_API_KEY（如 fork PR）→ 打印 skip、exit 0（标绿，不阻塞；复用 classifyEmail 缺 key 安全默认）。
//
// 此文件**不带 `.test.ts`**，故不被 `pnpm test`（glob src/**/*.test.ts）收集——真调模型只在显式 `pnpm eval:*` / eval.yml 跑。
// flaky 控制：复用 classifyEmail 内置「单次重试+fallback」+ openrouterClient 20s 超时；外层**不再加重试**（安全线要确定性、抖动=语料-模型不匹配信号）。
// ponytail: 串行跑（语料小）；若慢到难忍再切 ≤5 并发，别引并发框架。

import { config } from '../../config/config.js';
import { classifyEmail } from '../classifyEmail.js';
import { FALSE_POSITIVE, PHISHING, PHISHING_QUADRANT_B_COUNT, toEmail, type EvalSample } from './corpus.js';

const PHISHING_K = 5; // 每样例跑 5 次
const PHISHING_MIN_P4 = 3; // ≥3/5 落 P4 即 PASS（多数表决）
const FP_PASS_THRESHOLD = 0.7; // 误报集通过率阈值 Y=70%
const PHISHING_QUADRANT_B_MIN = 6; // 象限B 期望下限（守门实装阈，仅告警）

function isP4(priority: string): boolean {
  return priority === 'P4';
}
function isHighRated(priority: string): boolean {
  return priority === 'P0' || priority === 'P4';
}

/** 真钓鱼安全线：逐样本 k=5 多数表决。返回是否整套通过 + 逐样本明细。 */
async function runPhishing(samples: EvalSample[]): Promise<boolean> {
  if (PHISHING_QUADRANT_B_COUNT < PHISHING_QUADRANT_B_MIN) {
    console.warn(
      `⚠️  WARN: 象限B 真脱敏样例 ${PHISHING_QUADRANT_B_COUNT}/${PHISHING_QUADRANT_B_MIN}——守门未实装（仅象限A 合成占位）。` +
        `请按 corpus.ts 准则补 ≥${PHISHING_QUADRANT_B_MIN} 条真钓鱼语料，否则安全线只在「表层强」样例上有意义。`,
    );
  }
  let allPass = true;
  for (const s of samples) {
    let p4 = 0;
    for (let i = 0; i < PHISHING_K; i++) {
      const c = await classifyEmail(toEmail(s));
      if (isP4(c.priority)) p4++;
    }
    const pass = p4 >= PHISHING_MIN_P4;
    if (!pass) allPass = false;
    console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${s.id}  P4=${p4}/${PHISHING_K}  (${s.surface ?? '?'}/${s.deception ?? '?'})`);
  }
  return allPass;
}

/** 误报噪音线：k=1，通过率 ≥Y。 */
async function runFalsePositive(samples: EvalSample[]): Promise<boolean> {
  let pass = 0;
  for (const s of samples) {
    const c = await classifyEmail(toEmail(s));
    const ok = !isHighRated(c.priority); // 应降出 P0/P4
    if (ok) pass++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${s.id}  → ${c.priority}`);
  }
  const rate = samples.length === 0 ? 1 : pass / samples.length;
  console.log(`  通过率 ${pass}/${samples.length} = ${(rate * 100).toFixed(0)}%（阈值 ${FP_PASS_THRESHOLD * 100}%）`);
  return rate >= FP_PASS_THRESHOLD;
}

async function main(): Promise<void> {
  const suite = process.argv.includes('--suite')
    ? process.argv[process.argv.indexOf('--suite') + 1]
    : undefined;
  if (suite !== 'phishing' && suite !== 'false-positive') {
    console.error('用法：tsx src/classifier/eval/run.ts --suite phishing|false-positive');
    process.exit(2);
  }

  // 缺 key（fork PR / 本地未配）→ skip 标绿，不阻塞（classifyEmail 缺 key 会安全默认 P1，eval 无意义）。
  if (!config.OPENROUTER_API_KEY) {
    console.log(`[skip] 无 OPENROUTER_API_KEY → 跳过 ${suite} eval（标绿、不阻塞）。`);
    process.exit(0);
  }

  console.log(`== eval: ${suite} ==`);
  const ok =
    suite === 'phishing' ? await runPhishing(PHISHING) : await runFalsePositive(FALSE_POSITIVE);
  console.log(ok ? `✅ ${suite} PASS` : `❌ ${suite} FAIL`);
  process.exit(ok ? 0 : 1);
}

void main();
