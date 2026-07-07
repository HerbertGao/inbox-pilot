// seam B 不变量 self-check（migration §4.3，design D3）：
//   **唯一守护 re-poll「不丢推送」的不变量** `shouldNotifyNow ⊥ shouldMarkRead`——任一优先级下二者永不同真，
//   故 notify 耗尽留 unread 的封绝不被 mark_read 清 unread、下轮 re-poll 一定取得回。
//
// 非空断言纪律（tasks 4.3）：**跑真实 applySafetyRules 遍历优先级**（覆盖真实 email→decision 面），
// **非**复述 `{P0,P4}∩{P2,P3}=∅` 那种空断言。同时断言枚举**非空且真的触发过** shouldNotifyNow 与
// shouldMarkRead 两侧（否则不变量「恒不同真」可被「两侧都恒 false」空满足）。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applySafetyRules } from './applySafetyRules.js';
import type { Classification } from '../classifier/schema.js';
import type { NormalizedEmail } from '../normalizer/normalizeEmail.js';

function email(over: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    accountId: 'gmail:me@example.com',
    provider: 'gmail',
    providerMessageId: 'm1',
    subject: '普通主题 ordinary subject',
    fromEmail: 'sender@example.test',
    to: ['me@example.test'],
    date: '2026-07-07T00:00:00.000Z',
    hasAttachments: false,
    headers: {},
    ...over,
  };
}

function classification(over: Partial<Classification> = {}): Classification {
  return {
    priority: 'P2',
    category: 'work',
    should_notify_now: false,
    should_mark_read: false,
    should_include_digest: false,
    confidence: 0.9,
    reason: 'r',
    risk_flags: [],
    ...over,
  };
}

// 遍历真实 email→decision 面：LLM 建议优先级 × 置信度 × 类别 × 主题（含验证码强制 P0 面）——
// 覆盖每个最终优先级 P0–P4 及敏感守卫触发/未触发两态。
const PRIORITIES: Classification['priority'][] = ['P0', 'P1', 'P2', 'P3', 'P4'];
const CONFIDENCES = [0.9, 0.5]; // 0.5 < 0.65 → 触发低置信降级 P1 面。
const CATEGORIES: Classification['category'][] = ['work', 'marketing', 'security']; // security → 敏感守卫。
const SUBJECTS = [
  '普通主题 ordinary subject',
  'your verification code is 123456', // 验证码主题 → 强制 P0（shouldNotifyNow 面）。
];

test('4.3 不变量：跑真实 applySafetyRules 遍历优先级，无优先级同时 shouldNotifyNow ∧ shouldMarkRead', () => {
  let sawNotify = false;
  let sawMarkRead = false;
  let cases = 0;
  for (const priority of PRIORITIES) {
    for (const confidence of CONFIDENCES) {
      for (const category of CATEGORIES) {
        for (const subject of SUBJECTS) {
          const decision = applySafetyRules(
            email({ subject }),
            classification({ priority, confidence, category }),
          );
          cases += 1;
          // —— 核心不变量：二者永不同真（seam B 唯一守护）——
          assert.ok(
            !(decision.shouldNotifyNow && decision.shouldMarkRead),
            `优先级面 ${priority}/${confidence}/${category}/"${subject}" 违反 shouldNotifyNow ⊥ shouldMarkRead ` +
              `(final=${decision.priority}, notify=${decision.shouldNotifyNow}, markRead=${decision.shouldMarkRead})`,
          );
          if (decision.shouldNotifyNow) {
            sawNotify = true;
          }
          if (decision.shouldMarkRead) {
            sawMarkRead = true;
          }
        }
      }
    }
  }
  // 非空/非空满足守卫：枚举确实触发过两侧，否则「恒不同真」可被两侧恒 false 空满足。
  assert.ok(cases > 0, '枚举非空');
  assert.ok(sawNotify, '枚举触发过 shouldNotifyNow=true（P0/P4 面），非两侧恒 false 空满足');
  assert.ok(sawMarkRead, '枚举触发过 shouldMarkRead=true（P2/P3 非敏感面），非两侧恒 false 空满足');
});
