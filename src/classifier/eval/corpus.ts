// ③A 双向回归语料（rating-calibration-prompt / design「守门机制」决策 3）。
//
// 二象限矩阵（表层信号 × 内容欺骗）：
//   象限A 表层强+内容强（教科书钓鱼）  —— 配额 ≤30% 真钓鱼集，封顶防虚假安全感
//   象限B 表层弱+内容强（守门全部价值）—— 配额 ≥50%，**必须真脱敏**（合成会系统性偏到象限A）
//   象限C 表层强+内容弱（自有转发域假阳性）—— 进误报集
//   象限D 表层弱+内容弱（正常通知/收据）   —— 进误报集
//
// 隐私/安全：仓库**禁止**存活恶意内容——所有链接断活性写成 hxxp://placeholder.example；
// 真脱敏样例只动 PII、保语用结构（话术/紧迫感/欺骗前提逻辑链）、存文本投影不存 .eml。

import type { NormalizedEmail } from '../../normalizer/normalizeEmail.js';

export type EvalSample = {
  id: string;
  subject: string;
  fromEmail: string;
  fromName?: string;
  textBody: string;
  /** 仅真钓鱼集标注，供二象限配额审计（runner 不据此判定，只统计/告警）。 */
  surface?: 'weak' | 'strong';
  deception?: 'strong';
  /** 象限标注 + 来源（synthetic / real-desensitized），供 PR checklist 审计。 */
  note: string;
};

/** EvalSample → NormalizedEmail（补必填字段为中性默认；只喂分类器需要的投影字段）。 */
export function toEmail(s: EvalSample): NormalizedEmail {
  return {
    accountId: 'eval',
    provider: 'imap',
    providerMessageId: `eval-${s.id}`,
    subject: s.subject,
    fromEmail: s.fromEmail,
    fromName: s.fromName,
    to: ['me@example.test'],
    date: '2026-06-24T00:00:00.000Z',
    textBody: s.textBody,
    hasAttachments: false,
    headers: {},
  };
}

// ============================================================
// 误报集（噪音线、k=1、阈值 Y=70%）：经校准后**应**降出 P0/P4。象限 C/D，可合成。
// 种子取 design/proposal 列出的实证误报：网易登录 / PayPal 收据 / HKSS / 交易收据 / 银行账单 / 医院通知。
// ============================================================
export const FALSE_POSITIVE: EvalSample[] = [
  {
    id: 'fp-netease-login',
    subject: '网易邮箱登录提醒',
    fromEmail: 'do-not-reply@service.netease.com',
    fromName: '网易邮箱中心',
    textBody: '您的网易邮箱于 2026-06-24 10:21 在 Chrome 浏览器登录。如本人操作请忽略本邮件。',
    note: '象限D 合成：正常登录提醒（非异常/非欺骗）——应 P1/P2，不应 P4',
  },
  {
    id: 'fp-paypal-receipt',
    subject: 'You sent a payment of $12.99 USD',
    fromEmail: 'service@paypal.com',
    fromName: 'PayPal',
    textBody: 'Receipt for your purchase. Transaction ID 9XK... Amount $12.99. No action needed.',
    note: '象限D 合成：交易收据——应 P2，不应 P0/P4',
  },
  {
    id: 'fp-hkss-notice',
    subject: '強積金（MPF）月結單已備妥',
    fromEmail: 'noreply@hkss.example',
    fromName: 'HKSS',
    textBody: '您的月度結單已生成，可登入帳戶查閱。此為例行通知、無需即時處理。',
    note: '象限D 合成：例行月结单通知——应 P2，不应 P0',
  },
  {
    id: 'fp-txn-receipt',
    subject: '【交易成功】您的订单已支付',
    fromEmail: 'notify@shop.example',
    fromName: '某商城',
    textBody: '订单 2026062400123 支付成功，金额 ¥59.00，预计 3 日内发货。',
    note: '象限D 合成：交易/物流收据——应 P2（含「交易/支付」字样但无需立即动手）',
  },
  {
    id: 'fp-bank-statement',
    subject: '您的信用卡电子对账单已出',
    fromEmail: 'estatement@bank.example',
    fromName: '某银行',
    textBody: '本期账单已生成，应还金额 ¥1,234.00，最后还款日 2026-07-10。可登录网银查看明细。',
    note: '象限D 合成：银行账单（敏感但非欺骗）——应 P1/P2，不应 P4（敏感不自动已读由规则引擎守）',
  },
  {
    id: 'fp-hospital-appt',
    subject: '预约挂号成功通知',
    fromEmail: 'noreply@hospital.example',
    fromName: '某医院',
    textBody: '您已成功预约 2026-06-26 上午 内科门诊，请提前 15 分钟到院取号。',
    note: '象限D 合成：医院预约通知——应 P1/P2，不应 P4',
  },
  {
    id: 'fp-netease-newdevice-real',
    subject: '异地登录提醒',
    fromEmail: 'do-not-reply@service.netease.com',
    fromName: '网易邮箱中心',
    textBody: '检测到您的账号在新设备（北京）登录。若非本人操作，建议修改密码。本邮件不含任何链接。',
    note: '象限C 合成：异地登录提醒（表层像异常、但内容无欺骗诱导）——收紧后应 P1/P2，不应 P4',
  },
];

// ============================================================
// 真钓鱼集（安全线、k=5 多数表决、≥3/5 落 P4 即 PASS）：经校准后**必须仍 P4**。
//   象限A（合成、≤30% 封顶）：教科书钓鱼，表层+内容都强，信息量低。
//   象限B（**真脱敏、≥50%**，留待用户填）：表层弱+内容强，守门唯一价值所在、合成填不出。
// ============================================================

/** 象限A：合成教科书钓鱼（配额上限 ≤30%）。链接断活性。 */
const PHISHING_QUADRANT_A: EvalSample[] = [
  {
    id: 'ph-a-bank-reset',
    subject: '【紧急】您的账户存在安全风险，请立即验证',
    fromEmail: 'security@bank-verify.xyz',
    fromName: 'Bank Security',
    textBody:
      '检测到异常活动，您的账户将在 24 小时内冻结。请立即点击 hxxp://placeholder.example/verify 输入您的网银密码与短信验证码完成身份验证，否则资金将被冻结。',
    surface: 'strong',
    deception: 'strong',
    note: '象限A 合成：冒充银行 + 可疑 TLD(.xyz) + 紧迫感 + 诱导交出密码/验证码',
  },
  {
    id: 'ph-a-ceo-wire',
    subject: 'Re: 紧急付款',
    fromEmail: 'ceo@company-mail.xyz',
    fromName: '张总',
    textBody:
      '我在外面开会不方便接电话。现在有一笔紧急供应商款项需要你马上处理，先转 8.5 万到这个账户：6228… 收据发我，事后报销。越快越好，别跟别人说。',
    surface: 'strong',
    deception: 'strong',
    note: '象限A 合成：CEO 诈骗 + 冒充上级 + 紧迫/保密话术 + 诱导转账',
  },
];

/**
 * 象限B：表层弱（域名/格式正常）+ 内容欺骗强。**守门全部价值所在，必须 ≥50%、必须真脱敏**。
 *
 * ⚠️ 留待用户填（不可自动/合成生成——合成会系统性偏到象限A）。要求 8–12 条真钓鱼集里 ≥6 条在此。
 * 录入准则（design 决策 3 + PR checklist）：
 *   1. 真实样例**脱敏**：只动 PII（真实姓名/账号/金额/链接域名→占位符）、**保语用结构**；
 *      链接全部写成 hxxp://placeholder.example（断活性）；存本文本投影、不存 .eml。
 *   2. 压测剔伪装：「把所有表层异常（TLD/return-path/模板）替换成正常值后，仅凭正文，人类仍能判定是钓鱼吗？」
 *      答「否」者其实是象限A 伪装，剔除。
 *   3. 覆盖中文 5 类子型：仿冒银行/支付催缴 · 仿冒 HR/offer 索取信息 · 仿冒同事/上级转账 ·
 *      账号到期续费诈骗 · 仿冒物流补缴。
 *   每条标 surface:'weak' + deception:'strong'。
 */
const PHISHING_QUADRANT_B: EvalSample[] = [
  // TODO(用户前置动作)：在此填入 ≥6 条真脱敏的象限B 真钓鱼样例（见上准则）。
  // runner 在象限B 为空时会打印 WARN（守门未实装、仅占位），不阻塞。
];

export const PHISHING: EvalSample[] = [...PHISHING_QUADRANT_A, ...PHISHING_QUADRANT_B];

/** 象限B 计数（runner 据此告警「守门是否实装」）。 */
export const PHISHING_QUADRANT_B_COUNT = PHISHING_QUADRANT_B.length;
