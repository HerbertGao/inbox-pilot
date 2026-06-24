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
// 多数为**真脱敏样例**（取自 live DB 中被旧 prompt 过度评级为 P0/P4 的合法通知，
// 经 ssh 只读查询导出后脱敏：邮箱/姓名/地址/订单号/commit → 占位，账号专属 URL token 去除）；
// 末两条银行/医院为合成补类（DB 无、但属有效误报类）。这些「表层像告警/含交易字样、实则合法、
// 无欺骗诱导」者正是 ③A 收紧要从 P0/P4 压下去的——eval 验证 ≥70% 降出 P0/P4。
export const FALSE_POSITIVE: EvalSample[] = [
  {
    id: 'fp-google-newlogin',
    subject: '安全提醒',
    fromEmail: 'no-reply@accounts.google.com',
    fromName: 'Google',
    textBody:
      '我们发现您的 Google 账号在一部 Mac 设备上有新的登录活动。如果这是您本人的操作，那么您无需采取任何行动。如果这不是您本人的操作，我们会帮助您保护您的账号。查看活动：https://myaccount.google.com/notifications',
    note: '象限C 真脱敏：Google 新登录活动提醒——表层「安全/新登录」但纯信息、无诱导行动 → 应 P1/P2、不应 P4',
  },
  {
    id: 'fp-google-app-password',
    subject: '安全提醒',
    fromEmail: 'no-reply@accounts.google.com',
    fromName: 'Google',
    textBody:
      '已创建用于登录您账号的应用专用密码。如果您本人未曾为某应用生成此密码，则表明有人可能在使用您的账号。请立即检查您的账号并确保其安全。查看活动：https://myaccount.google.com/notifications',
    note: '象限C 真脱敏：Google 应用专用密码创建——表层「有人可能在使用您的账号」吓人但合法、无欺骗诱导 → 不应 P4',
  },
  {
    id: 'fp-github-signin-review',
    subject: '[GitHub] Please review this sign in',
    fromEmail: 'noreply@github.com',
    fromName: 'GitHub',
    textBody:
      'Your GitHub account was successfully signed in to but we did not recognize the location of the sign in. If you recently signed in, you do not need to take any further action. If you did not sign in, your password may be compromised. Visit https://github.com/settings/security to create a new password.',
    note: '象限C 真脱敏：GitHub 异地登录复核——表层「未识别位置/密码可能泄露」但合法平台通知、无诱导交密码 → 不应 P4',
  },
  {
    id: 'fp-netease-newdevice',
    subject: '新设备登录提醒',
    fromEmail: 'safe@service.netease.com',
    fromName: '网易邮箱',
    textBody:
      '您的邮箱账号在一台新设备上登录。若为本人操作请忽略本邮件；若非本人操作，建议尽快修改密码并开启二次验证。',
    note: '象限C 真脱敏：网易新设备登录提醒——表层像异地登录告警、合法平台、无欺骗 → 不应 P4',
  },
  {
    id: 'fp-apple-receipt',
    subject: 'Apple 提供的收据',
    fromEmail: 'no_reply@email.apple.com',
    fromName: 'Apple',
    textBody:
      '收据及续期通知。订单号 XXXXXXXX，Apple 账户 user@example.com。AppleCare+ 服务计划 月度方案 $0.99，下次收费日期 2026年7月24日，将自动续期。此通知用于确认你已购买月度服务计划。如需管理订阅或查看购买记录请访问账户信息。',
    note: '象限D 真脱敏：Apple AppleCare+ 收据/续期——交易收据、无需立即动手 → 应 P2、不应 P0/P4',
  },
  {
    id: 'fp-paypal-receipt',
    subject: 'Apple Services: $0.99 USD',
    fromEmail: 'service@paypal.com',
    fromName: 'PayPal',
    textBody:
      '您向 Apple Services 支付了 $0.99 USD。交易日期 2026年6月23日，订单号 XXXXXXXX，使用 VISA 信用卡 ••XXXX，对账单显示为 PP*APPLE.COM/BILL。如对本次购物有任何疑问，请联系商家。',
    note: '象限D 真脱敏：PayPal 交易收据——含「交易/付款」字样但纯收据、无需立即动手 → 应 P2、不应 P0/P4',
  },
  {
    id: 'fp-gitguardian-alert',
    subject: '<repo> - 4 internal incidents detected',
    fromEmail: 'support@gitguardian.com',
    fromName: 'GitGuardian',
    textBody:
      'GitGuardian security alert: 4 internal secret incidents detected — MySQL Credentials, PostgreSQL Credentials, Generic Password — in <repo> (commit XXXXXXX). See on GitGuardian / See on GitHub. GitGuardian is an automated secret scanner.',
    note: '象限C 真脱敏：GitGuardian 密钥扫描告警——表层「incidents detected/credentials」吓人但合法自动化工具通知 → 不应 P4',
  },
  {
    id: 'fp-bank-statement',
    subject: '您的信用卡电子对账单已出',
    fromEmail: 'estatement@bank.example',
    fromName: '某银行',
    textBody: '本期账单已生成，应还金额 ¥1,234.00，最后还款日 2026-07-10。可登录网银查看明细。',
    note: '象限D 合成（DB 无此类）：银行账单（敏感但非欺骗）——应 P1/P2、不应 P4（敏感不自动已读由规则引擎守）',
  },
  {
    id: 'fp-hospital-appt',
    subject: '预约挂号成功通知',
    fromEmail: 'noreply@hospital.example',
    fromName: '某医院',
    textBody: '您已成功预约 2026-06-26 上午 内科门诊，请提前 15 分钟到院取号。',
    note: '象限D 合成（DB 无此类）：医院预约通知——应 P1/P2、不应 P4',
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
  // 缺口已查证·接受（见 tasks 3.2）：live DB 1243 封中**零真钓鱼**——Gmail 上游已把钓鱼过滤进垃圾邮件、
  // 摄入的是已过滤邮件，故 DB 供不出象限B；用户确认垃圾箱亦无。当前仅象限A 合成兜底，象限B 留空，
  // runner 会 WARN「守门未实装」。安全线在象限B 上欠武装，靠引擎硬底线 + confidence<0.65 兜底；
  // 真实暴露面低（钓鱼进不了处理流）。如日后捞到真样例，按上方准则脱敏后填入即可武装安全线。
];

export const PHISHING: EvalSample[] = [...PHISHING_QUADRANT_A, ...PHISHING_QUADRANT_B];

/** 象限B 计数（runner 据此告警「守门是否实装」）。 */
export const PHISHING_QUADRANT_B_COUNT = PHISHING_QUADRANT_B.length;
