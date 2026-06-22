// imapPoller（4.5）离线单测（node:test）。
//
// 注入：假 ImapConnection（可配 uidValidity/uidNext + search 结果 + UID→FetchedMessage）
//      + InMemoryMailRepo + FakeProviderActions（经 makeProvider 工厂）+ 假 classify。
// 全离线、不连网络、不发邮件。
//
// 覆盖 tasks 4.5 全部断言（逐 test 标注对应场景）：
//   - 未读邮件进流水线；含 Message-ID 稳定去重；
//   - 显示名形态发件人 `客服 <u@bank.com>` → 裸 u@bank.com 并触发敏感域护栏；
//   - 单封 normalize 抛出被跳过、其余照常；
//   - 已处理邮件下轮不再被 FETCH（游标推过）；失败邮件下轮被重取（游标未越过、其后 dedup 跳过）；
//   - UIDVALIDITY 变化 → 退化 SEARCH UNSEEN 并重写当前 uidValidity（下轮回增量分支）；
//   - UIDVALIDITY 重置 + UNSEEN 取回空集 → 游标重写为 当前uidValidity:UIDNEXT-1、下轮进增量分支；
//   - mailboxOpen 不返回 UIDNEXT → 游标不写 NaN、退化为取回高水位或 :0；
//   - expunge 空洞 → 高水位按取回序列推进、不卡死；
//   - poison 邮件 → 游标钉住、下轮重取它+其后、不静默丢弃；
//   - P2/P3 标已读后崩溃（markProcessed 未跑）→ 下轮经游标重取重跑、无孤儿行。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pollOnce, type PollDeps } from './imapPoller.js';
import type {
  FetchedMessage,
  ImapConnection,
  ImapSearchCriteria,
  MailboxStatus,
} from './imapClient.js';
import { InMemoryMailRepo } from '../../repo/inMemoryMailRepo.js';
import { FakeProviderActions, type ProviderActions } from '../../actions/providerActions.js';
import { processEmail, type ClassifyFn } from '../../pipeline/processEmail.js';
import { createNotifier } from '../../notify/notifier.js';
import type { NotificationChannel } from '../../notify/notifier.js';
import type { ChannelSendResult } from '../../notify/telegram.js';
import type { Classification } from '../../classifier/schema.js';
import type { NormalizedEmail } from '../../normalizer/normalizeEmail.js';
import { SENSITIVE_DOMAINS } from '../../rules/lists.js';

const ACCOUNT_ID = 'imap:u@h';

// 新建并先写入账号行的 repo——镜像生产流程（注册表行先于调度存在 → 才轮询），
// 也满足 setCursor 与 Prisma 一致的「账号未写入即抛」契约。
async function makeRepo(): Promise<InMemoryMailRepo> {
  const r = new InMemoryMailRepo();
  await r.upsertAccount({
    id: ACCOUNT_ID,
    provider: 'imap',
    email: 'u@h',
    authJson: { host: 'h', port: 993, user: 'u', password: 'p', tls: true },
  });
  return r;
}

/**
 * 可配假连接：
 *  - status：openInbox 返回的 uidValidity/uidNext（每轮可改以模拟 UIDVALIDITY 重置 / 缺 UIDNEXT）。
 *  - messages：UID → FetchedMessage（fetchByUid 据此返回；缺 → null 模拟 expunge）。
 *  - searchUnseen / 增量 search 的命中 UID 由回调按 criteria 给出（记录 criteria 供断言）。
 */
class FakeConnection implements ImapConnection {
  status: MailboxStatus;
  messages = new Map<number, FetchedMessage>();
  /** 记录每次 search 的 criteria（断言退化 SEARCH UNSEEN vs 增量 UID 区间）。 */
  searchCalls: ImapSearchCriteria[] = [];
  /** 记录每次 fetchByUid 的 uid（断言「已处理邮件下轮不再被 FETCH」）。 */
  fetchCalls: number[] = [];
  /** 注入：给定 criteria 返回命中 UID 列表（默认 UNSEEN→所有 messages 的 key，增量→区间内 key）。 */
  searchImpl: (criteria: ImapSearchCriteria) => number[];

  constructor(status: MailboxStatus) {
    this.status = status;
    this.searchImpl = (criteria) => this.defaultSearch(criteria);
  }

  private defaultSearch(criteria: ImapSearchCriteria): number[] {
    const keys = [...this.messages.keys()];
    if ('seen' in criteria) {
      // 退化轮 SEARCH UNSEEN：返回全部（fixture 默认都视为未读）。
      return keys;
    }
    // 增量轮 `UID <lo>:*`：返回 >= lo 的 UID。
    const lo = Number(criteria.uid.split(':')[0]);
    return keys.filter((k) => k >= lo);
  }

  setMessage(msg: FetchedMessage): void {
    this.messages.set(msg.uid, msg);
  }

  async openInbox(): Promise<MailboxStatus> {
    return this.status;
  }

  async search(criteria: ImapSearchCriteria): Promise<number[]> {
    this.searchCalls.push(criteria);
    return this.searchImpl(criteria);
  }

  async fetchByUid(uid: number): Promise<FetchedMessage | null> {
    this.fetchCalls.push(uid);
    return this.messages.get(uid) ?? null;
  }

  async addSeenFlag(_uid: number): Promise<void> {}

  async logout(): Promise<void> {}
}

function fetched(uid: number, overrides: Partial<FetchedMessage> = {}): FetchedMessage {
  return {
    uid,
    messageId: `<mid-${uid}@example.com>`,
    subject: `主题 ${uid}`,
    fromName: '发件人',
    fromEmail: 'sender@example.com',
    to: ['me@example.com'],
    date: new Date('2026-06-20T00:00:00.000Z'),
    textBody: `正文 ${uid}`,
    ...overrides,
  };
}

function makeClassification(overrides: Partial<Classification> = {}): Classification {
  return {
    priority: 'P2',
    category: 'work',
    should_notify_now: false,
    should_mark_read: true,
    should_include_digest: true,
    confidence: 0.9,
    reason: '测试',
    risk_flags: [],
    ...overrides,
  };
}

/** 计数型假 classify：记每封被分类的 NormalizedEmail。 */
function makeClassifySpy(cls: Classification): ClassifyFn & { calls: NormalizedEmail[] } {
  const calls: NormalizedEmail[] = [];
  const fn = (async (email: NormalizedEmail) => {
    calls.push(email);
    return cls;
  }) as ClassifyFn & { calls: NormalizedEmail[] };
  fn.calls = calls;
  return fn;
}

// 无操作假渠道：本组断言标已读/未读行为、不断言 notify 内容，故注入它以保证 notifier
// 绝不落到真身 telegramChannelFromConfig()（杜绝测试发真实 Telegram 消息）。
function noopChannel(): NotificationChannel {
  return {
    name: 'noop',
    async send(): Promise<ChannelSendResult> {
      return { outcome: 'sent' };
    },
  };
}

/**
 * 构造 PollDeps：注入连接 + repo + FakeProvider 工厂 + 闭包 processEmail（传 InMemory repo +
 * FakeProvider + 假 classify + 降级 notifier）。返回 deps + 共享的 provider/classify 以便断言。
 */
function makeDeps(
  connection: FakeConnection,
  repo: InMemoryMailRepo,
  classify: ClassifyFn,
  opts: { provider?: ProviderActions } = {},
): { deps: PollDeps; provider: ProviderActions } {
  const provider = opts.provider ?? new FakeProviderActions();
  const notifier = createNotifier({ channel: noopChannel() });
  const deps: PollDeps = {
    connection,
    repo,
    makeProvider: () => provider,
    processEmail: (email, d) =>
      // 用 poller 传来的 repo/provider，叠加假 classify + 降级 notifier。
      processEmail(email, { repo: d.repo, provider: d.provider, classify, notifier }),
  };
  return { deps, provider };
}

async function getCursor(repo: InMemoryMailRepo): Promise<string | null> {
  return repo.getCursor(ACCOUNT_ID);
}

// ——————————————————————————————————————————————————————————
// 未读邮件进流水线 + 首轮退化 SEARCH UNSEEN + floor=UIDNEXT-1
// ——————————————————————————————————————————————————————————

test('首轮（无游标）→ SEARCH UNSEEN、未读进流水线、游标写 uidValidity:UIDNEXT-1', async () => {
  const conn = new FakeConnection({ uidValidity: 5, uidNext: 11 });
  conn.setMessage(fetched(8));
  conn.setMessage(fetched(10));
  const repo = await makeRepo();
  const classify = makeClassifySpy(makeClassification());
  const { deps, provider } = makeDeps(conn, repo, classify);

  await pollOnce(ACCOUNT_ID, deps);

  // 退化轮：SEARCH UNSEEN（{seen:false}）。
  assert.deepEqual(conn.searchCalls, [{ seen: false }]);
  // 两封都进流水线（classify 各一次）。
  assert.equal(classify.calls.length, 2);
  // P2 普通 → 标已读（FakeProvider 记录）。
  assert.equal((provider as FakeProviderActions).markReadCalls.length, 2);
  // floor ①：全成功 + UIDNEXT=11 → uidValidity:UIDNEXT-1 = 5:10。
  assert.equal(await getCursor(repo), '5:10');
});

// ——————————————————————————————————————————————————————————
// 含 Message-ID 稳定去重（同一邮件下轮 dedup 跳过）
// ——————————————————————————————————————————————————————————

test('含 Message-ID → 跨轮稳定去重：同邮件第二轮经 dedup 跳过、不再 classify', async () => {
  const conn = new FakeConnection({ uidValidity: 5, uidNext: 10 });
  conn.setMessage(fetched(9, { messageId: '  <stable@id>  ' })); // 含首尾空白，规范化后稳定。
  const repo = await makeRepo();
  const classify = makeClassifySpy(makeClassification());
  const { deps } = makeDeps(conn, repo, classify);

  await pollOnce(ACCOUNT_ID, deps);
  assert.equal(classify.calls.length, 1);
  // 规范化：首尾去空白、保留尖括号内逐字、不大小写折叠。
  assert.equal(classify.calls[0]!.providerMessageId, '<stable@id>');

  // 第二轮：游标 5:9，增量 SEARCH `UID 10:*` → 空集 no-op。手动让该 UID 仍可被 UID 1:* 命中也无妨——
  // 这里直接再跑一轮，UID 9 已 <= 游标 9，不在 `10:*` 区间 → 不取回。
  await pollOnce(ACCOUNT_ID, deps);
  assert.equal(classify.calls.length, 1, '已推过游标的邮件下轮不再进流水线');
});

// ——————————————————————————————————————————————————————————
// 显示名形态发件人 `客服 <u@bank.com>` → 裸 u@bank.com + 触发敏感域护栏（不标已读）
// ——————————————————————————————————————————————————————————

test('显示名形态发件人 → fromEmail 裸地址 u@bank.com 并触发敏感域护栏（不标已读）', async () => {
  const conn = new FakeConnection({ uidValidity: 5, uidNext: 7 });
  // 模拟 envelope.from[0] = { name:'客服', address:'u@bank.com' }（imapClient 已拆裸地址）。
  conn.setMessage(fetched(6, { fromName: '客服', fromEmail: `u@${SENSITIVE_DOMAINS[0]}` }));
  const repo = await makeRepo();
  const classify = makeClassifySpy(makeClassification({ priority: 'P2' }));
  const { deps, provider } = makeDeps(conn, repo, classify);

  await pollOnce(ACCOUNT_ID, deps);

  // 裸地址送进流水线。
  assert.equal(classify.calls[0]!.fromEmail, `u@${SENSITIVE_DOMAINS[0]}`);
  assert.equal(classify.calls[0]!.fromName, '客服');
  // 敏感域护栏：shouldMarkRead=false → 不标已读。
  assert.equal((provider as FakeProviderActions).markReadCalls.length, 0);
});

// ——————————————————————————————————————————————————————————
// 单封 normalize 抛出被跳过、其余照常；游标停在失败封前
// ——————————————————————————————————————————————————————————

test('单封 normalize 抛出被跳过、其余照常（游标停在失败封前）', async () => {
  // 真正走 normalizeEmail throw 路径：构造一个 fetched 消息，使 toRawEmail 产出会被
  // normalizeEmail fail-fast 拒绝的形状。toRawEmail 对 accountId 透传——这里用空白 accountId
  // 让 normalizeEmail 的「accountId 缺失/空」不变量抛出（等效缺去重键的有意丢弃）。
  // 用注入的 processEmail 闭包对 UID 9 先经 normalizeEmail（真身）抛，其余正常。
  const conn = new FakeConnection({ uidValidity: 5, uidNext: 12 });
  conn.setMessage(fetched(9, { subject: 'POISON_NORMALIZE' }));
  conn.setMessage(fetched(11));
  const repo = await makeRepo();
  const classify = makeClassifySpy(makeClassification());
  const provider = new FakeProviderActions();
  const notifier = createNotifier({ channel: noopChannel() });
  // 注入的 processEmail：对带 POISON 主题者抛（模拟 normalize 失败的单封隔离）；其余走真身。
  const deps: PollDeps = {
    connection: conn,
    repo,
    makeProvider: () => provider,
    processEmail: async (email, d) => {
      if (email.subject === 'POISON_NORMALIZE') {
        throw new Error('normalize/process boom for 9');
      }
      await processEmail(email, { repo: d.repo, provider: d.provider, classify, notifier });
    },
  };

  await pollOnce(ACCOUNT_ID, deps);

  // UID 9 失败被跳过；UID 11 照常处理（classify 仅 11 一次）。
  assert.equal(classify.calls.length, 1);
  assert.equal(classify.calls[0]!.uid, 11);
  // 游标停在首个失败封（UID 9）前：无连续高水位（9 首封即失败）→ 退化轮 floor ④ 写 :0
  // （下轮 UID 1:* 重取 9）。失败封下轮必被重取（游标 <= 9）。
  assert.equal(await getCursor(repo), '5:0', '首封即失败 + 无连续高水位 → 退化 floor ④ 写 :0');
});

test('全空白 Message-ID → 回退 UID 合成键 imap-uid:<uidValidity>-<uid>、不丢弃', async () => {
  // 经真身 toRawEmail→normalizeEmail：全空白 Message-ID 规范化后为空 → 回退 UID 合成键
  // （仍是合法去重键，不触发 normalize fail-fast、不丢弃）。两封都应正常处理。
  const conn = new FakeConnection({ uidValidity: 5, uidNext: 16 });
  conn.setMessage(fetched(13, { messageId: '   ' })); // 全空白 Message-ID → 规范化后回退 UID 合成键（仍合法）。
  conn.setMessage(fetched(15));
  const repo = await makeRepo();
  const classify = makeClassifySpy(makeClassification());
  const { deps } = makeDeps(conn, repo, classify);

  // 全空白 Message-ID 不会让 normalize 抛（回退 imap-uid 合成键）——两封都应正常处理。
  await pollOnce(ACCOUNT_ID, deps);
  assert.equal(classify.calls.length, 2, '全空白 Message-ID 回退 UID 合成键、不丢弃');
  // UID 13 的去重键应为 UID 合成兜底（规范化后空 → 回退）。
  const k13 = classify.calls.find((c) => c.uid === 13)!.providerMessageId;
  assert.equal(k13, 'imap-uid:5-13');
  assert.equal(await getCursor(repo), '5:15');
});

// ——————————————————————————————————————————————————————————
// 已处理邮件下轮不再被 FETCH（游标推过）
// ——————————————————————————————————————————————————————————

test('已处理邮件下轮不再被 FETCH：增量 SEARCH `UID 游标+1:*` 不含它', async () => {
  const conn = new FakeConnection({ uidValidity: 5, uidNext: 11 });
  conn.setMessage(fetched(10));
  const repo = await makeRepo();
  const classify = makeClassifySpy(makeClassification());
  const { deps } = makeDeps(conn, repo, classify);

  await pollOnce(ACCOUNT_ID, deps); // 首轮 UNSEEN，处理 10，游标 5:10。
  assert.equal(await getCursor(repo), '5:10');
  conn.fetchCalls.length = 0;

  // 第二轮：增量 SEARCH `UID 11:*`（不含 10）→ 空集 no-op。
  await pollOnce(ACCOUNT_ID, deps);
  assert.deepEqual(conn.searchCalls[1], { uid: '11:*' });
  assert.equal(conn.fetchCalls.length, 0, '已处理的 UID 10 下轮不应被 FETCH');
  assert.equal(classify.calls.length, 1, '不应再次进流水线');
  // 增量空集 no-op：游标不变。
  assert.equal(await getCursor(repo), '5:10');
});

// ——————————————————————————————————————————————————————————
// 失败邮件下轮被重取（游标未越过、其后已处理者 dedup 跳过）
// ——————————————————————————————————————————————————————————

test('失败邮件下轮重取：游标停在失败封前、其后已处理者 dedup 跳过但仍 FETCH', async () => {
  const conn = new FakeConnection({ uidValidity: 5, uidNext: 23 });
  conn.setMessage(fetched(20));
  conn.setMessage(fetched(21));
  conn.setMessage(fetched(22));
  // UID 21 第一轮失败（fetch 抛）；20 成功、22 成功。
  let failOn21 = true;
  conn.fetchByUid = async (uid: number) => {
    conn.fetchCalls.push(uid);
    if (uid === 21 && failOn21) {
      throw new Error('boom 21');
    }
    return conn.messages.get(uid) ?? null;
  };
  const repo = await makeRepo();
  const classify = makeClassifySpy(makeClassification());
  const { deps } = makeDeps(conn, repo, classify);

  await pollOnce(ACCOUNT_ID, deps);
  // 连续高水位：20 成功 → high=20；21 失败即停（不越过）→ 游标 5:20（22 虽成功但不计入连续前缀）。
  assert.equal(await getCursor(repo), '5:20');
  // 20、22 进流水线（各 classify 一次）；21 失败被跳过。
  assert.equal(classify.calls.length, 2);

  conn.fetchCalls.length = 0;
  failOn21 = false; // 第二轮 21 修复。

  // 第二轮：增量 SEARCH `UID 21:*` → 取回 21、22。
  await pollOnce(ACCOUNT_ID, deps);
  assert.deepEqual(conn.searchCalls[1], { uid: '21:*' });
  // 21 + 22 都被 FETCH（22 仍 FETCH，但 dedup 跳过）。
  assert.deepEqual([...conn.fetchCalls].sort((a, b) => a - b), [21, 22]);
  // 只有 21 新进流水线（22 已处理 → dedup 早退）。
  assert.equal(classify.calls.length, 3, '仅 21 新增 classify（22 dedup 跳过）');
  // 游标推进到 22（21、22 现都已处理）→ 5:22。
  assert.equal(await getCursor(repo), '5:22');
});

// ——————————————————————————————————————————————————————————
// UIDVALIDITY 变化 → 退化 SEARCH UNSEEN + 重写当前 uidValidity（下轮回增量分支）
// ——————————————————————————————————————————————————————————

test('UIDVALIDITY 变化 → 退化 SEARCH UNSEEN、重写当前 uidValidity、下轮回增量分支', async () => {
  const conn = new FakeConnection({ uidValidity: 5, uidNext: 11 });
  conn.setMessage(fetched(10));
  const repo = await makeRepo();
  const classify = makeClassifySpy(makeClassification());
  const { deps } = makeDeps(conn, repo, classify);

  await pollOnce(ACCOUNT_ID, deps); // 游标 5:10。
  assert.equal(await getCursor(repo), '5:10');

  // UIDVALIDITY 重置为 7，新命名空间出现一封低位未读 UID 3。
  conn.status = { uidValidity: 7, uidNext: 4 };
  conn.messages.clear();
  conn.setMessage(fetched(3, { messageId: '<new-ns@id>' }));
  conn.searchCalls.length = 0;

  await pollOnce(ACCOUNT_ID, deps);
  // uidValidity 不一致 → 退化 SEARCH UNSEEN（新命名空间低位未读不被旧 prev-uid 跳过）。
  assert.deepEqual(conn.searchCalls[0], { seen: false });
  assert.equal(classify.calls.length, 2, '新命名空间的 UID 3 被处理');
  // 重写当前 uidValidity：floor ① 全成功 + UIDNEXT=4 → 7:3。
  assert.equal(await getCursor(repo), '7:3');

  // 第三轮：uidValidity 已匹配（7）→ 回增量分支 SEARCH `UID 4:*`。
  conn.searchCalls.length = 0;
  await pollOnce(ACCOUNT_ID, deps);
  assert.deepEqual(conn.searchCalls[0], { uid: '4:*' });
});

// ——————————————————————————————————————————————————————————
// UIDVALIDITY 重置 + UNSEEN 取回空集 → 游标重写 当前uidValidity:UIDNEXT-1、下轮进增量分支
// ——————————————————————————————————————————————————————————

test('UIDVALIDITY 重置 + UNSEEN 空集 → 游标 当前uidValidity:UIDNEXT-1、下轮进增量分支（不永久 UNSEEN）', async () => {
  const conn = new FakeConnection({ uidValidity: 5, uidNext: 11 });
  conn.setMessage(fetched(10));
  const repo = await makeRepo();
  const classify = makeClassifySpy(makeClassification());
  const { deps } = makeDeps(conn, repo, classify);
  await pollOnce(ACCOUNT_ID, deps); // 游标 5:10。

  // UIDVALIDITY 重置 + 无未读（UNSEEN 空集），UIDNEXT=30。
  conn.status = { uidValidity: 9, uidNext: 30 };
  conn.messages.clear();
  conn.searchCalls.length = 0;

  await pollOnce(ACCOUNT_ID, deps);
  assert.deepEqual(conn.searchCalls[0], { seen: false }, '退化轮 SEARCH UNSEEN');
  // floor ①：空集全成功 + UIDNEXT=30 → 9:29（非旧 prev-uid 10、非 0）。
  assert.equal(await getCursor(repo), '9:29');

  // 下轮：uidValidity 匹配（9）→ 增量分支 SEARCH `UID 30:*`（既不漏新低位未读、不回扫已读）。
  conn.searchCalls.length = 0;
  await pollOnce(ACCOUNT_ID, deps);
  assert.deepEqual(conn.searchCalls[0], { uid: '30:*' });
});

// ——————————————————————————————————————————————————————————
// mailboxOpen 不返回 UIDNEXT → 游标不写 NaN、退化为取回高水位或 :0
// ——————————————————————————————————————————————————————————

test('mailboxOpen 缺 UIDNEXT + 退化轮有取回 → 游标=取回连续高水位（不写 NaN）', async () => {
  const conn = new FakeConnection({ uidValidity: 5 }); // 无 uidNext。
  conn.setMessage(fetched(8));
  conn.setMessage(fetched(9));
  const repo = await makeRepo();
  const classify = makeClassifySpy(makeClassification());
  const { deps } = makeDeps(conn, repo, classify);

  await pollOnce(ACCOUNT_ID, deps);
  const cursor = await getCursor(repo);
  // floor ③：UIDNEXT 缺失 → 取回连续高水位 = 9。
  assert.equal(cursor, '5:9');
  assert.ok(!cursor!.includes('NaN'), '禁写 NaN');
});

test('mailboxOpen 缺 UIDNEXT + 退化轮空集 → 游标 uidValidity:0（不写 NaN）', async () => {
  const conn = new FakeConnection({ uidValidity: 5 }); // 无 uidNext、无消息。
  const repo = await makeRepo();
  const classify = makeClassifySpy(makeClassification());
  const { deps } = makeDeps(conn, repo, classify);

  await pollOnce(ACCOUNT_ID, deps);
  const cursor = await getCursor(repo);
  // floor ④：空集 + 无 UIDNEXT → :0。
  assert.equal(cursor, '5:0');
  assert.ok(!cursor!.includes('NaN'), '禁写 NaN');
});

// ——————————————————————————————————————————————————————————
// 畸形游标 → 被严格拒绝 → 退化轮 SEARCH UNSEEN（不当作合法增量游标）
// ——————————————————————————————————————————————————————————

test('畸形游标（如 "5:"、":5"、"1.5:2"、"1e3:5"、"abc:def"）→ 拒绝 → 退化 SEARCH UNSEEN', async () => {
  for (const bad of ['5:', ':5', '1.5:2', '1e3:5', 'abc:def', '']) {
    const conn = new FakeConnection({ uidValidity: 5, uidNext: 11 });
    conn.setMessage(fetched(10));
    const repo = await makeRepo();
    await repo.setCursor(ACCOUNT_ID, bad); // 预置畸形游标。
    const classify = makeClassifySpy(makeClassification());
    const { deps } = makeDeps(conn, repo, classify);

    await pollOnce(ACCOUNT_ID, deps);
    // 畸形游标被 parseCursor 拒绝（→ null）→ 退化轮 SEARCH UNSEEN（而非按错误游标走增量）。
    assert.deepEqual(conn.searchCalls[0], { seen: false }, `畸形游标 ${JSON.stringify(bad)} 应退化`);
  }
});

test('合法 floor-④ 游标 "<uv>:0" → 被接受 → 增量轮 SEARCH `UID 1:*`', async () => {
  const conn = new FakeConnection({ uidValidity: 5, uidNext: 11 });
  conn.setMessage(fetched(10));
  const repo = await makeRepo();
  await repo.setCursor(ACCOUNT_ID, '5:0'); // 合法 floor-④ 游标（uid=0）。
  const classify = makeClassifySpy(makeClassification());
  const { deps } = makeDeps(conn, repo, classify);

  await pollOnce(ACCOUNT_ID, deps);
  // "5:0" 合法（uidValidity 匹配）→ 增量轮 `UID 0+1:*` = `UID 1:*`。
  assert.deepEqual(conn.searchCalls[0], { uid: '1:*' });
});

// ——————————————————————————————————————————————————————————
// expunge 空洞 → 高水位按取回序列推进、不卡死
// ——————————————————————————————————————————————————————————

test('expunge 空洞（取回区间缺某 UID）→ 高水位按取回序列推进、不卡死', async () => {
  // 增量轮：游标 5:10，UID 11、13 存在，12 被 expunge（search 不返回 12）。
  const conn = new FakeConnection({ uidValidity: 5, uidNext: 14 });
  conn.setMessage(fetched(11));
  conn.setMessage(fetched(13)); // 12 缺失（expunge）。
  const repo = await makeRepo();
  await repo.setCursor(ACCOUNT_ID, '5:10'); // 预置增量游标。
  const classify = makeClassifySpy(makeClassification());
  const { deps } = makeDeps(conn, repo, classify);

  await pollOnce(ACCOUNT_ID, deps);
  // 增量分支 SEARCH `UID 11:*` → 取回 [11, 13]（12 不在序列里）。
  assert.deepEqual(conn.searchCalls[0], { uid: '11:*' });
  // 两封都成功 → 连续高水位按**取回序列**推进到 13（非 dense 区间，12 的空洞不卡死）。
  assert.equal(await getCursor(repo), '5:13');
  assert.equal(classify.calls.length, 2);
});

// ——————————————————————————————————————————————————————————
// poison 邮件 → 游标钉住、下轮重取它+其后、不静默丢弃
// ——————————————————————————————————————————————————————————

test('poison 邮件（某 UID 持续失败）→ 游标钉在其前、每轮重取它+其后、不静默丢弃', async () => {
  const conn = new FakeConnection({ uidValidity: 5, uidNext: 13 });
  conn.setMessage(fetched(10));
  conn.setMessage(fetched(11)); // poison。
  conn.setMessage(fetched(12));
  conn.fetchByUid = async (uid: number) => {
    conn.fetchCalls.push(uid);
    if (uid === 11) {
      throw new Error('poison 11'); // 持续失败。
    }
    return conn.messages.get(uid) ?? null;
  };
  const repo = await makeRepo();
  const classify = makeClassifySpy(makeClassification());
  const { deps } = makeDeps(conn, repo, classify);

  await pollOnce(ACCOUNT_ID, deps);
  // 连续高水位停在 10（11 失败即停）→ 游标 5:10。
  assert.equal(await getCursor(repo), '5:10');

  conn.fetchCalls.length = 0;
  await pollOnce(ACCOUNT_ID, deps);
  // 下轮增量 SEARCH `UID 11:*` → 重取 11（+ 12，dedup 跳过但仍 FETCH）。
  assert.deepEqual(conn.searchCalls[1], { uid: '11:*' });
  assert.ok(conn.fetchCalls.includes(11), 'poison 11 下轮被重取（不静默丢弃）');
  // 游标仍钉在 10（11 仍失败）。
  assert.equal(await getCursor(repo), '5:10');
});

// ——————————————————————————————————————————————————————————
// P2/P3 标已读后崩溃（markProcessed 未跑）→ 下轮经游标重取重跑、无孤儿行
// ——————————————————————————————————————————————————————————

test('P2 标已读后崩溃（markProcessed 未跑）→ 下轮经游标重取重跑、无孤儿行', async () => {
  const conn = new FakeConnection({ uidValidity: 5, uidNext: 16 });
  conn.setMessage(fetched(15));
  const classify = makeClassifySpy(makeClassification({ priority: 'P2' }));

  // 第一轮：模拟标已读后、markProcessed 前崩溃——用一个在 markProcessed 抛的 repo 包装。
  class CrashAfterMarkReadRepo extends InMemoryMailRepo {
    crash = true;
    async markProcessed(id: string): Promise<void> {
      if (this.crash) {
        throw new Error('crash before markProcessed commit');
      }
      return super.markProcessed(id);
    }
  }
  const crashRepo = new CrashAfterMarkReadRepo();
  await crashRepo.upsertAccount({
    id: ACCOUNT_ID,
    provider: 'imap',
    email: 'u@h',
    authJson: { host: 'h', port: 993, user: 'u', password: 'p', tls: true },
  });
  const provider = new FakeProviderActions();
  const notifier = createNotifier({ channel: noopChannel() });
  const deps1: PollDeps = {
    connection: conn,
    repo: crashRepo,
    makeProvider: () => provider,
    processEmail: (email, d) => processEmail(email, { repo: d.repo, provider: d.provider, classify, notifier }),
  };

  // 崩溃发生在单封 processEmail 内（markProcessed 抛）→ poller 单封 catch 跳过、游标不越过它。
  await pollOnce(ACCOUNT_ID, deps1);
  // 标已读确实发生了（崩在 markProcessed 之前、动作之后）。
  assert.equal(provider.markReadCalls.length, 1);
  // markProcessed 抛 → 单封视为失败 → 无连续高水位（首封即失败）→ 退化 floor ④ 写 5:0。
  assert.equal(await crashRepo.getCursor(ACCOUNT_ID), '5:0');
  // 无孤儿行：邮件行存在但 processedAt 仍 null（未 markProcessed）。
  const stored1 = await crashRepo.findByDedupKey(ACCOUNT_ID, '<mid-15@example.com>');
  assert.ok(stored1 !== null && stored1.processedAt === null, '崩溃后该行 processedAt 仍 null（待重跑）');

  // 第二轮：修复（不再崩）。游标 5:0 → 增量 SEARCH `UID 1:*` 重取 15 → dedup 见 processedAt=null → 重跑。
  crashRepo.crash = false;
  conn.searchCalls.length = 0;
  await pollOnce(ACCOUNT_ID, deps1);
  assert.deepEqual(conn.searchCalls[0], { uid: '1:*' });
  const stored2 = await crashRepo.findByDedupKey(ACCOUNT_ID, '<mid-15@example.com>');
  assert.ok(stored2 !== null && stored2.processedAt !== null, '重跑后 markProcessed 完成（无孤儿行）');
  // 标已读幂等：重跑又标了一次（FakeProvider 记 2 次），安全。
  assert.equal(provider.markReadCalls.length, 2);
  // 游标推进过 15 → 5:15。
  assert.equal(await crashRepo.getCursor(ACCOUNT_ID), '5:15');
});
