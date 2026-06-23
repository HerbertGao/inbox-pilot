// IMAP 口令来源解析（inbox-pilot-cli §6）。
//
// 自包含模块：绝不 import account.ts / config.ts。仅取注入的原语 + 依赖（promptHidden / stdin 包装），
// 由调用方在 IMAP add 路径接线。密钥绝不进 argv——三种来源：
//   --password-stdin（非 TTY 管道喂入）、--password-file <path>（读文件）、否则交互隐藏提示（默认）。
//
// 安全要点：
//   - 三源互斥（§6.2）。
//   - --password-stdin TTY 守卫（§6.5）：无管道 → 拒绝固定文案、不阻塞。
//   - --password-file open-then-fstat（§6.3）：以 O_RDONLY|O_NONBLOCK **非阻塞**先 open 取 fd、再对
//     打开的 fd fstat（避免 stat-路径-再-open 的 TOCTOU 窗口）；非阻塞 open 使 0600 FIFO（POSIX 只读
//     open 会等写者）立即返回、由 isFile() 拒绝、不永久阻塞；group/other 可读（mode & 0o077）→ 拒绝；
//     路径经 JSON.stringify 转义渲染，绝不原样回显（嵌入路径控制字符不得经错误信息注入伪造 stderr/日志行）。
//   - trim 语义（§6.4）：只剥单个尾随换行（/\r?\n$/），绝不整体 .trim()（保留口令合法首尾空格）。

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/**
 * §6.6 反模式警示——账号 CLI 在 usage/--help 中并入此串。
 * --password-stdin 应从文件/变量喂入，绝不 `echo "literal" |`（密钥会落 echo 进程 argv → shell history / ps）。
 */
export const PASSWORD_STDIN_USAGE_HINT =
  '口令经 < secret.txt 或 $VAR 喂入 --password-stdin；勿用 echo "literal" |（会落 shell 历史 / ps）';

export type PasswordSourceDeps = {
  /** 交互隐藏提示（注入）——默认来源；绝不回显输入。 */
  promptHidden: () => Promise<string>;
  /** 可注入 stdin 包装（便于测试）：isTTY 用于 TTY 守卫，read 读取管道全部内容。 */
  stdin: { isTTY: boolean; read: () => Promise<string> };
};

/** 只剥单个尾随换行（§6.4）；绝不 .trim()。 */
function stripTrailingNewline(content: string): string {
  return content.replace(/\r?\n$/, '');
}

/**
 * 按优先级解析 IMAP 口令：--password-stdin / --password-file / 交互隐藏提示（默认）。
 * 三源互斥。返回判别联合：成功 { ok:true, password } / 失败 { ok:false, message }（由调用方映射 EXIT_USAGE）。
 */
export async function resolveImapPassword(
  opts: { passwordStdin: boolean; passwordFile: string | undefined },
  deps: PasswordSourceDeps,
): Promise<{ ok: true; password: string } | { ok: false; message: string }> {
  const sourcesGiven = [opts.passwordStdin, opts.passwordFile !== undefined].filter(Boolean).length;
  if (sourcesGiven > 1) {
    return {
      ok: false,
      message: '口令来源互斥：--password-stdin / --password-file / 交互提示只能用其一',
    };
  }

  // --password-stdin：TTY 守卫 + 读管道、剥单尾换行。
  if (opts.passwordStdin) {
    if (deps.stdin.isTTY) {
      return {
        ok: false,
        message: '--password-stdin 需经管道喂入（< secret.txt 或 $VAR），当前为 TTY',
      };
    }
    const raw = await deps.stdin.read();
    return { ok: true, password: stripTrailingNewline(raw) };
  }

  // --password-file：open-then-fstat（TOCTOU 安全）+ 常规文件强制 + 权限强制 + 读 fd、剥单尾换行。
  // 整个 open→stat→read 序列包在 try/catch：任何 open/stat/read 失败（ENOENT/EACCES/EISDIR/FIFO 块等）
  // 都映射为 { ok:false }（→ 调用方 EXIT_USAGE），绝不外逃成未映射 throw（会被顶层 catch 误判为 EXIT_FAILURE）。
  if (opts.passwordFile !== undefined) {
    const path = opts.passwordFile;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      // 非阻塞 open（O_RDONLY|O_NONBLOCK）：0600 FIFO / symlink-to-FIFO 的 POSIX 只读 open 本会等写者
      // 永久阻塞——非阻塞使其立即返回 fd、随后 isFile() 拒之；常规文件用 O_NONBLOCK 仍正常 open/read。
      handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile()) {
        // 非常规文件（目录 / FIFO / 设备 / 指向非常规的符号链接）：拒绝。非阻塞 open + isFile 挡住 0600 FIFO
        // 的永久阻塞。路径经 JSON.stringify 转义渲染——绝不原样回显（防控制字符注入伪造日志/stderr 行）。
        return { ok: false, message: `口令文件须为常规文件: ${JSON.stringify(path)}` };
      }
      if ((stat.mode & 0o077) !== 0) {
        // 路径经 JSON.stringify 转义渲染——绝不原样回显（防控制字符注入伪造日志/stderr 行）。
        return {
          ok: false,
          message: `口令文件权限过宽（group/other 可读）: ${JSON.stringify(path)}`,
        };
      }
      const content = await handle.readFile('utf8');
      return { ok: true, password: stripTrailingNewline(content) };
    } catch {
      // open/stat/read 失败：固定文案 + 转义路径（绝不回显原始 error / 原样路径）。
      return { ok: false, message: `无法读取口令文件: ${JSON.stringify(path)}` };
    } finally {
      // fd 仅在 open 成功时存在；best-effort 关闭、绝不外抛（close() 可能 reject，须吞掉——否则
      // 会把一次成功读取翻成未映射 throw → 顶层误判 EXIT_FAILURE）。
      if (handle !== undefined) {
        try {
          await handle.close();
        } catch {
          /* best-effort */
        }
      }
    }
  }

  // 默认：交互隐藏提示。
  const password = await deps.promptHidden();
  return { ok: true, password };
}
