# gmail-integration 规范

## 目的
待定 - 由归档变更 gmail-multi-account 创建。归档后请更新目的。
## 需求
### 需求:Gmail OAuth 授权与 token 持久化
系统必须支持 Gmail 账号经 OAuth2「已安装应用 / loopback」流程接入：用 env 的 app 凭据（`GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET`/`GMAIL_REDIRECT_URI`）生成授权链接，用户授权后换取 **refresh token 存入 `MailAccount.authJson`**；运行期用 refresh token 自动换取 access token（短期、不长存）。**运行期自动 refresh 后只回写 refreshToken(仅当 Google 轮换了它),绝不把 `access_token`/`expiry` 写入 `authJson`**(保 access token 不落 at-rest;有测试断言 authJson 不出现 access_token 键)。

**授权流程必须（硬性）**：
- 用 **Desktop-app（已安装应用）OAuth client**，回调采用 **loopback 一次性本地 HTTP 回调**：**先绑 `127.0.0.1` 的临时空闲端口**，再用**该实际端口**构造**唯一精确 redirect_uri** `http://127.0.0.1:<bound-port>/oauth2/callback`，并在**授权 URL 与 token 交换（`getToken`）两处用同一精确 URI（含端口）**——Google 对 installed-app loopback 要求 redirect_uri 两处**精确一致（含端口）**，否则 `redirect_uri_mismatch`。Desktop client 的 loopback 端口**动态、无需在 GCP 预注册具体端口**（区别于 Web client 的固定注册 URI；本期用 Desktop client，故无需注册具体端口）。host **必须为 `127.0.0.1`**（IPv4 字面量；**不允许 `localhost`/`[::1]`**——监听绑 IPv4，`[::1]`(IPv6) 到不了 IPv4 监听、`localhost` 解析有歧义，均致授权静默失败），config 加载校验 `GMAIL_REDIRECT_URI` host（端口运行时绑定后填入）、否则 onboarding 显式失败。**禁止** OOB（`urn:ietf:wg:oauth:2.0:oob`「粘贴 code」）——Google 已于 2022 停用。
- 授权请求必须带 `access_type=offline` **且 `prompt=consent`**——后者保证**即使该账号此前已授权**也返回 refresh token（否则常见的「已授权过」场景拿不到 refresh token）；换取结果**缺 refresh token 仍必须显式失败**（记错、不建残缺账号）作为兜底,文档提供 revoke-并重试 路径。
- 授权请求必须带 **PKCE**（`code_challenge_method=S256`）;`code_verifier` 优先用 `google-auth-library` 的 `generateCodeVerifierAsync()`（避免手搓 base64url 编码错误致 PKCE 静默失效）;同一 verifier 必须**回传进 token 交换**（`getToken({codeVerifier})`）——必须有测试断言「发起侧 challenge 的 verifier == token 交换用的 verifier」（防 PKCE 被静默旁路）。
- 授权请求必须带 **`state`**（`crypto.randomBytes`）;loopback 回调必须**路径精确匹配**(忽略 `/favicon.ico` 等噪声请求、不在其上消费 state/code)、校验 `state` 匹配（**先长度检查再常量时间比较**——长度非密;`timingSafeEqual` 对不等长会抛,故缺失/不等长 `state` 按「非匹配」走下面的不消费分支、不抛崩监听）;**state 不匹配的请求不消费 one-shot 名额**(仅匹配成功才退役该次,防错误 state 洪泛饿死合法回调);匹配成功的 `state`/`code` **只消费一次**（拒绝重复/并发回调的第二次,不重复交换）;回调若返回 `error=`（如 `access_denied`）必须**干净中止**(不尝试 token 交换、不建账号);监听器必须在 `finally` 关闭、设**同意超时**(超时丢弃 verifier+state、关监听)、并**限请求行/头大小 + 连接数**(本地 DoS 加固);超时与单次消费互斥(已消费则超时不再 finalize)。
- Gmail 账号身份（`email`,用于派生 accountId `gmail:<email>`）必须**仅**取自 `users.getProfile().emailAddress`,并**规范化（仅小写）**:信任 getProfile 返回的规范地址,**不**剥点/不去 `+tag`/不折叠 `googlemail.com≡gmail.com`(剥点会误并不同 Workspace 地址);使同一邮箱跨 重授权/CLI重加 产出同一 accountId;**禁**用 `id_token`(其需 `openid`/`email` scope,违反「scope 恰为 gmail.modify」)。

**Scope 与「绝不发送」硬约束**：OAuth scope 必须**恰好等于**单元素集 `{https://www.googleapis.com/auth/gmail.modify}`（全 URL 形式贯穿全文,测试以规范化单元素集**精确相等**断言,不用子串/缺失判定）。**禁止**任何更宽或含发送能力的 scope（`gmail.send`、`gmail.compose`、`https://mail.google.com/`、`gmail.settings.*`、`openid`/`email`）。注意 `gmail.modify` 在 Google 侧**技术上也接受 `messages.send`**——故「绝不自动发送/回复」**由代码落地**（provider 无 send 方法、全代码路径无 `messages.send`、有断言测试断言已构建 provider 的方法面无 send）,**不**由 scope 边界保证。运行期实际能力以 token 携带的 scope 为准;onboarding 是 scope 关口,如 scope 政策变更需重授权。

app 凭据从 env 读、账号 token 存 authJson；**两者都绝不入日志**。**OAuth 回调 URL/query（含单次性授权 `code` 与 `state`）绝不整体入日志**:回调处理只记固定字段 `{kind, state-result, path}`,**绝不记 `code`/`state`/完整回调 URL**（`code` 是 onboarding 期 OAuth 机密,虽单次+PKCE 绑定降低被截获价值,仍按机密对待）;须有断言:日志中无授权 `code` 子串。某账号 refresh 失败（token 撤销/过期）时必须**隔离**:该账号轮询失败、记结构化错误（标记需重新授权）、**不崩进程、不拖累其他账号**。refresh/auth 失败的错误对象（`google-auth-library`/`gaxios` `GaxiosError` 的 `.response.data`/`.config.data` 可含 `refresh_token`/`client_secret` **字符串子串**,pino key-redact 无法清洗子串）**禁止**整体入日志:只取 `error.code` + 固定 kind 串;必须有测试喂含凭据子串的合成 `GaxiosError` 断言输出无 token/secret 子串。

#### 场景:授权换取并存储 refresh token
- **当** 用户对一个 Gmail 账号完成 OAuth 授权（loopback 回调、state 校验通过、`access_type=offline`+`prompt=consent`）
- **那么** 系统必须把 refresh token 存入该账号的 `MailAccount.authJson`,account email 取自 `users.getProfile`(规范化),且 token **不出现在任何日志**

#### 场景:已授权账号仍得 refresh token
- **当** 一个此前已授权过本应用的 Gmail 账号重新走 add 流程
- **那么** 因 `prompt=consent`,授权仍返回 refresh token;若仍缺则显式失败并提示 revoke-重试,不静默落残缺账号

#### 场景:state/code 只消费一次、error 干净中止
- **当** loopback 回调 `state` 不匹配、或同一 state/code 第二次到达、或返回 `error=access_denied`
- **那么** 回调必须拒绝/中止、不换取/不存任何 token,监听器在 finally 关闭

#### 场景:回调端口占用不致命
- **当** onboarding 起 loopback 监听
- **那么** 先绑临时空闲端口、再用该端口构造唯一精确 `redirect_uri`(授权 URL 与 `getToken` 两处一致含端口),避免 `EADDRINUSE`;无法绑定时显式失败、不建账号

#### 场景:scope 恰为白名单且 PKCE 真生效
- **当** 生成 Gmail 授权链接并换取 token
- **那么** scope 必须**精确相等** `{gmail.modify(全URL)}`(禁 send/compose/全权限/openid);发起侧 PKCE verifier 必须等于 token 交换所用 verifier(有断言测试);代码侧无任何 `messages.send` 路径(有断言测试)

#### 场景:refresh 失败隔离且不泄露
- **当** 某 Gmail 账号 refresh token 失效(撤销/过期),自动 refresh 抛 `GaxiosError`(token 端点 `invalid_grant`、HTTP **400**、body `{error:'invalid_grant'}`,`message='invalid_grant'`)
- **那么** 该账号**标记需重授权**:抛 `ProviderReauthRequired` → guard suspend + `enabled=false`(跨重启停轮询,**与 403 scope 失配同路径**;`invalid_grant` 是账号级致命**不当瞬时每 tick 重试**),记错(只记 `error.code`+固定 kind,**不**记 `.response`/`.config`/原始对象),其他账号轮询照常、进程不崩;有测试断言输出无 token/secret 子串

#### 场景:回调不记 code/URL
- **当** loopback 回调被处理(无论 state 匹配/不匹配/error)
- **那么** 日志只含 `{kind, state-result, path}`,**绝不**含授权 `code`/`state`/完整回调 URL;有测试断言日志无授权 `code` 子串

### 需求:Gmail 轮询并收敛为 NormalizedEmail
Gmail 轮询必须 `users.messages.list(q='is:unread')` 取未读集,**先用 list 返回的 message id 对去重键 `(accountId, providerMessageId)`+`processedAt` 预去重**(命中已处理者**跳过、不调 `messages.get`)——**DB `processedAt` 是去重权威**;仅对未处理者逐条 `messages.get(format='full')`(`metadata` 不含正文、削弱关键词轴,故用 full)。`AI/Processed` 标签**仅作可选 cosmetic 处理标记,不作去重权威/不作 list 过滤的唯一依据**——避免「打了标签但 `processedAt` 未落」的崩溃窗口造成永久漏处理(此前缺陷)。`// ponytail: 每轮 list 全部未读 + DB 预去重;大量未读时上 historyId 增量或 post-commit AI/Processed 过滤,属后续。`

**分页(必须,穷尽 list、只限 get)**:`messages.list` 默认每页 ≤100、用 `nextPageToken` 翻页。**每轮必须穷尽翻页**(列完所有未读页——纯 id、轻),每页 list-id 先对 `(accountId,providerMessageId)`+`processedAt` 预去重(跳过已处理、不 get)。**预算只设在 `messages.get`/处理数上(非翻页数)**:`// ponytail: 默认每轮处理上限 ≤200 封`。**持久进度即 DB `processedAt`**(无需 Gmail 游标):未处理者**按最旧优先处理**(`messages.list` 默认最新优先,故取穷尽后的 id 列**逆序**)至 get 预算,超出的未处理件**本轮不处理、下一轮穷尽 list 时再次被发现并处理**(已处理者经预去重跳过)——故 backlog 跨轮逐步排空、不靠「下轮续」的隐式游标;**最旧优先**确保持续涌入的新件不会饿死最旧未处理件(否则新件总排在 list 前、耗尽预算)。**禁**把预算设在翻页数上(否则 P0/P1/P4 长期未读堆满前几页、翻页预算耗尽 → 更旧未处理件永不被列到 → 饿死)。

取详情后映射 RawEmail 再 `normalizeEmail`(分类器禁止接收未规范化的原始 Gmail 对象)。`providerMessageId`=Gmail message id(跨重启稳定);`providerThreadId`=threadId。正文/头映射:`snippet`→`snippet`;解码 `text/plain`(base64url)→`textBody`;**无 `text/plain` 时必须把 `text/html` 去标签为纯文本→`textBody`（去标签前先剔除 `<script>`/`<style>` 块,否则 CSS/JS 文本污染分类输入；`// ponytail: 轻量去标签足够,完整 HTML 解析属后续`）**——分类器 `buildClassifierInput` **只读 `textBody`/`snippet`/`headers`、绝不读 `htmlBody`**(防 HTML 注入/token 膨胀),故 HTML-only 邮件若只映射 htmlBody 会令模型**收不到正文**→分类退化;`htmlBody` 可选保留(审计);`payload.headers` 中**分类器白名单的安全/退订轴头**(`reply-to`/`return-path`/`list-unsubscribe`/`authentication-results`——见 `classifyEmail.ts` `HEADER_WHITELIST`)→`headers`(from/subject 经各自字段入模型、不必塞 headers;`// ponytail: 仅映射分类器白名单头 + 轻量去标签,全头/完整 HTML 解析属后续`)。**HTML-only 是正常邮件**,经上述 html→text 投影正常进流水线,不当畸形跳过。**全无可提取正文**(加密 S/MIME、纯附件:无 text/plain、无 text/html、无 snippet)→ 以 subject+headers 分类(安全降级:低置信→P1,符合 AI 失败降级硬约束),不丢弃。本期 Gmail **不用游标**:`poll()` 不调用 `getCursor`/`setCursor`(cursor seam 仅 IMAP 用),`lastSyncCursor` 留空。

**逐封与读侧错误隔离(区分单封跳过 vs 整轮结束)**:每封的**映射/收敛/解析**错误(缺 From / payload 截断 / 映射抛出;HTML-only 不算畸形)**逐封 try/catch+skip+log**、不中断整批。但 **429/配额** 与 **`ProviderReauthRequired`(403)** 即使在逐封 `messages.get` 路径上出现,也必须**绕过单封 skip、向上抛以结束本轮并隔离**(否则会逐封 skip 继续翻页、反而加剧限流)——记脱敏错误、不崩、不拖累其他账号;因 DB 去重 + 未推进,下一轮重列安全可重复。

#### 场景:未处理未读被收敛并进入流水线
- **当** Gmail 账号存在未读且 `processedAt` 未落的邮件
- **那么** 每封必须经 `messages.get(format='full')` 取详情、收敛为 `NormalizedEmail`、调用 `processEmail`

#### 场景:已处理的长期未读不重复 get(DB 权威、不依赖标签)
- **当** P0/P1/P4 等邮件被处理(`processedAt` 已落)后**保持未读**,下一轮仍在未读集
- **那么** 必须经 list-id 对 `(accountId,providerMessageId)+processedAt` 预去重跳过,**不**再 `messages.get`;即使 `AI/Processed` 标签缺失(崩溃未打)也照常跳过(标签非唯一依据)、不重复处理、不漏处理

#### 场景:HTML-only 去标签为 textBody 喂分类器
- **当** 某封为 HTML-only(无 text/plain)
- **那么** 必须把 `text/html` 去标签为纯文本→`textBody`(使分类器收到正文,因其不读 htmlBody),正常进流水线,**不**当畸形跳过

#### 场景:全无正文安全降级
- **当** 某封无 text/plain、无 text/html、无 snippet(加密/纯附件)
- **那么** 以 subject+headers 分类(低置信→P1 的安全降级),不丢弃、不崩

#### 场景:分页不饿死旧未读
- **当** 未读数 > 单页(含大量长期未读 P0/P1/P4)
- **那么** 必须**穷尽** `nextPageToken` 翻页(列完所有未读页)、逐页预去重、对未处理者**按最旧优先(list 默认最新优先故逆序)**处理至 **get 预算**(预算在 get 数而非翻页数);超出预算的未处理件下一轮穷尽 list 时再次被发现并处理(已处理者经 `processedAt` 预去重跳过),更旧的未处理未读**不被首页堆积饿死、也不被持续涌入的新件饿死**

#### 场景:单封畸形不中断整批
- **当** 某封 `messages.get` 缺 From / payload 截断 / 映射抛出
- **那么** 该封被 catch+skip+log,整批其余照常处理

#### 场景:读侧 429 结束本轮并隔离
- **当** `messages.list`/`messages.get` 返回 429 / 配额错误
- **那么** 本轮结束、记脱敏错误、不崩进程、不拖累其他账号;下一轮重列重试

### 需求:Gmail 按规则裁定执行动作（AI 标签 + 去 UNREAD）
Gmail provider 必须按规则引擎裁定的 `FinalDecision` 执行动作:**始终** `reflectPriority` 打**优先级标签**;**仅当** `FinalDecision.shouldMarkRead` 为 true 时 `markRead` 去 `UNREAD`（`messages.modify` removeLabelIds `['UNREAD']`,幂等）。provider **禁止**自行判断优先级或读 `Classification`;P4/敏感/低置信已被 `applySafetyRules` 置 `shouldMarkRead=false`,故**绝不**被去 UNREAD（但仍打优先级标签——打标签不改读状态,不违反「P4/敏感不自动标已读」;且 P4 邮件保持未读 + 带 `AI/P4_Risk` 标签在 Gmail 中**用户可见**,即便 P0/P4 通知重试耗尽仍可见、不丢失）。

**标签名取 PROJECT_INIT §6.1 权威映射**:

| 优先级 | 标签 | 去 UNREAD |
|---|---|---|
| P0 | `AI/P0_Important_Now` | 否 |
| P1 | `AI/P1_Later` | 否 |
| P2 | `AI/P2_Digest` | 是 |
| P3 | `AI/P3_Marketing` | 是 |
| P4 | `AI/P4_Risk` | 否 |

`AI/Processed`(cosmetic 处理标记)可选;若使用,作 best-effort 标记,**不**作去重唯一依据(见「轮询」需求)。

**动作顺序(防崩溃窗口)**:`reflectPriority`(打标签)必须在 `markRead`(去 UNREAD)**之前**执行,`notify` 居 markRead 之后(沿用 P3),`markProcessed` 最后(即 `reflectPriority → markRead → notify → markProcessed`)。因去 UNREAD 是唯一「使邮件不再被 `is:unread` 取到」的动作:先打标签保证「已不可再列(已读)」的邮件至少已带 `AI/P*` 标签;残留窗口仅为「去 UNREAD 成功、`markProcessed` 前崩溃」——此时分类已落库(`saveClassification` 在动作前)、标签已打、已读,仅 `processedAt` 滞后,且 P2/P3 无即时通知,**无用户可见丢失**(at-most-once-after-action,与 P3 语义一致;`// ponytail: 彻底闭合需 Gmail historyId 游标,属后续`)。

**标签创建幂等(create-or-get)**:标签缺失则 `labels.create` 并缓存 labelId;**labelId 缓存必须按 `(accountId, labelName)` 键**(Gmail 标签按账号隔离,仅按 name 键会把 A 账号的 labelId 误用于 B 账号);并发/首轮 `labels.create` 返回 **409「已存在」**必须按「取该账号下已存在 labelId」处理(不当致命错误)。`reflectPriority` 必须**幂等**(重复打同一标签安全)、且与 `markRead`/`markProcessed` **失败隔离**:单动作发送态失败只落 `mail_actions`(动作类型 `reflect_priority`,见 design;需新增 `ActionType`)、不阻断其余动作与 `markProcessed`;终态落库 I/O 故障向上传播由 at-least-once 重跑兜底(标签幂等、重打无害)。

**错误分类(两条不同通道)**:
- 写侧 **429/配额 + 一般发送态失败** 是**瞬时**错误,走既有 `executeActions` 发送态契约:脱敏固定 kind、落 `mail_actions` failed、**不抛**、邮件仍照常 `markProcessed`(不因限流/单次失败卡住该封)。
- **403 权限不足/scope 失配**(存量 token 实际 scope 漂移、窄于 `gmail.modify`,如仅 `gmail.readonly`)**不是瞬时错误**,**不能**走发送态吞-继续通道(否则每封都「failed+markProcessed」致该账号永久静默不打标签/不去 UNREAD)。provider 必须抛**带类型的致命错误 `ProviderReauthRequired`**;`executeActions` 对该类型**重新抛出(不吞,区别于发送态失败)** → `processEmail` 因此**跳过 `markProcessed`** → per-account guard catch、**隔离该账号本轮并标记需重新授权**(与读侧 refresh 失败同路径);其他账号不受影响。错误脱敏(**禁含** token/邮箱/响应明文)。

**禁止**任何发送/回复动作。

#### 场景:优先级标签始终打、去 UNREAD 受规则门控
- **当** 一封 Gmail 邮件经规则裁定为最终优先级 P{n}
- **那么** 必须打对应权威标签(如 P0→`AI/P0_Important_Now`,无论是否标已读);仅当 `shouldMarkRead` 为 true 才去 `UNREAD`

#### 场景:P0/P4 与敏感保持未读且可见
- **当** `FinalDecision.shouldMarkRead` 为 false(P0/P1/P4、敏感、低置信)
- **那么** Gmail provider **禁止**去 `UNREAD`,但仍打对应 `AI/P*` 标签;该邮件在 Gmail 保持未读+带标签、用户可见,即便通知失败也不丢失

#### 场景:labelId 缓存按账号隔离、409 取已存在
- **当** 两账号(或首轮并发)对同名缺失标签 `labels.create`
- **那么** labelId 缓存按 `(accountId,labelName)` 隔离;409「已存在」取该账号下已存在 labelId,不作致命错误

#### 场景:动作失败/429 脱敏不阻断
- **当** `messages.modify`/`labels.create` 因瞬时 API 错误(含 429)失败
- **那么** 错误**禁含** token/邮箱/响应明文(固定 kind),落 `mail_actions` failed,不阻断其余动作与 `markProcessed`

#### 场景:403 scope 失配抛致命错误、跳过 markProcessed、隔离
- **当** 存量 token 实际 scope 窄于 `gmail.modify`,动作返回 403 权限不足
- **那么** provider 抛 `ProviderReauthRequired`,`executeActions` 重新抛出(不当发送态吞掉),`processEmail` 跳过该封 `markProcessed`,per-account guard 隔离该账号本轮并标记需重新授权(不反复 failed+markProcessed 致永久静默);其他账号不受影响

#### 场景:标签先于去 UNREAD
- **当** 一封 P2/P3 邮件(shouldMarkRead=true)
- **那么** 必须先 `reflectPriority` 打标签、再 `markRead` 去 UNREAD、最后 `markProcessed`;去 UNREAD 后崩溃(markProcessed 前)该邮件仍已带标签+已分类落库,无用户可见丢失

