/**
 * dsh-acp-window-guard
 *
 * 背景（2026-11 实测）：billion-context(ACP) 计算“可用窗口”= contextWindow − maxTokens。
 * 正常会话由宿主透传 x-bili-plugin-context-window（本案 1,000,000 − 128,000 = 872,000）。
 * 但拿不到透传头的“匿名链”(pfa-*) 会退回配置默认 200,000，再扣预留 32,768 = 167,232，
 * 于是压缩到 32 万 token 仍被判超窗 → 继续转发 → 上游 400 / 干等 15s 无首字节。
 *
 * 本插件做两件事（都幂等、都可关）：
 *   1) 把 ACP 配置文件里的 modelContextLimit 抬到 minContextLimit（默认 1,000,000）；
 *   2) 若 ACP 的 dist/agent/dsh-native.js 在升级后被换回原样，重新打上“窗口缺失时按
 *      MIN_ASSUMED_WINDOW_TOKENS 兜底”的补丁，让超窗请求在本地被 422 拒掉而不是裸发。
 *
 * 全部操作失败都只记日志、不抛异常，绝不影响宿主启动。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'acp-window-guard'

const DEFAULT_MIN_CONTEXT_LIMIT = 1_000_000
const OLD_CALL = 'bodyProvablyOverWindow2(body,init,effectiveContextWindow(ctx))'
const NEW_CALL = 'bodyProvablyOverWindow2(body,init,effectiveContextWindow(ctx)??MIN_ASSUMED_WINDOW_TOKENS)'

function stamp() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function acpConfigPath(config = {}) {
  if (config.configFile) return config.configFile
  if (process.env.BILI_CONFIG_FILE) return process.env.BILI_CONFIG_FILE
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, 'billion-context', 'billion-context.json')
}

export function acpBundleCandidates(config = {}) {
  const list = []
  if (config.acpBundlePath) list.push(config.acpBundlePath)
  const home = os.homedir()
  const profiles = path.join(home, '.dsh', 'profiles')
  try {
    for (const p of fs.readdirSync(profiles)) {
      list.push(path.join(profiles, p, 'node_modules', 'billion-context', 'dist', 'agent', 'dsh-native.js'))
    }
  } catch {}
  return list
}

/** 1) 确保 modelContextLimit 足够大 */
export function ensureContextLimit(config = {}, log = console.log) {
  const target = Number(config.minContextLimit ?? DEFAULT_MIN_CONTEXT_LIMIT)
  const file = acpConfigPath(config)
  try {
    if (!fs.existsSync(file)) return { ok: true, changed: false, reason: `no acp config at ${file} (ACP 未安装或从未启动过)` }
    const before = JSON.parse(fs.readFileSync(file, 'utf8'))
    const cur = Number(before.modelContextLimit)
    if (Number.isFinite(cur) && cur >= target) return { ok: true, changed: false, current: cur, file }
    if (config.dryRun) return { ok: true, changed: false, wouldChange: true, from: Number.isFinite(cur) ? cur : null, to: target, file }
    const backup = `${file}.bak-window-guard-${stamp()}`
    fs.copyFileSync(file, backup)
    before.modelContextLimit = Math.max(Number.isFinite(cur) ? cur : 0, target)
    fs.writeFileSync(file, JSON.stringify(before, null, 2) + '\n', 'utf8')
    log(`[acp-window-guard] modelContextLimit ${Number.isFinite(cur) ? cur : '(unset)'} -> ${before.modelContextLimit} in ${file} (backup: ${path.basename(backup)}); 重启 ACP 代理后生效`)
    return { ok: true, changed: true, from: Number.isFinite(cur) ? cur : null, to: before.modelContextLimit, backup, file }
  } catch (err) {
    log(`[acp-window-guard] 配置检查失败（不影响启动）: ${err?.message ?? err}`)
    return { ok: false, changed: false, error: String(err?.message ?? err) }
  }
}

/** 2) 确保 ACP 超窗保险补丁在位（升级后被覆盖则重打） */
export function ensureBundlePatch(config = {}, log = console.log) {
  if (config.patchAcpCode === false) return { ok: true, changed: false, reason: 'disabled by config' }
  const tried = []
  for (const file of acpBundleCandidates(config)) {
    tried.push(file)
    try {
      if (!fs.existsSync(file)) continue
      const text = fs.readFileSync(file, 'utf8')
      const already = text.split(NEW_CALL).length - 1
      const raw = text.split(OLD_CALL).length - 1
      if (raw === 0 && already >= 2) return { ok: true, changed: false, patched: already, file }
      if (raw === 0) return { ok: false, changed: false, reason: 'pattern not found (bundle 结构已变，需人工复核)', file }
      if (config.dryRun) return { ok: true, changed: false, wouldChange: true, callSites: raw, file }
      const backup = `${file}.bak-window-guard-${stamp()}`
      fs.copyFileSync(file, backup)
      const next = text.split(OLD_CALL).join(NEW_CALL)
      fs.writeFileSync(file, next, 'utf8')
      log(`[acp-window-guard] ACP 超窗保险补丁已重打（${raw} 处）: ${file} (backup: ${path.basename(backup)}); 重启 ACP 代理后生效`)
      return { ok: true, changed: true, callSites: raw, backup, file }
    } catch (err) {
      log(`[acp-window-guard] 补丁处理失败（不影响启动）: ${err?.message ?? err}`)
    }
  }
  return { ok: true, changed: false, reason: `未找到 ACP bundle（查过 ${tried.length} 个候选路径）` }
}

export function runGuard(config = {}, log = console.log) {
  const limit = ensureContextLimit(config, log)
  const patch = ensureBundlePatch(config, log)
  return { limit, patch }
}

export function apply(ctx, config = {}) {
  const sink = typeof ctx?.logger?.info === 'function'
    ? (m) => ctx.logger.info(m)
    : (...a) => console.log(...a)
  try {
    const r = runGuard(config, sink)
    sink(`[acp-window-guard] 就绪: contextLimit=${r.limit.changed ? 'patched' : (r.limit.error ? 'error' : 'ok')}, bundle=${r.patch.changed ? 'patched' : (r.patch.ok ? 'ok' : 'attention')}`)
    return r
  } catch (err) {
    sink(`[acp-window-guard] 整体失败（已忽略）: ${err?.message ?? err}`)
    return { ok: false }
  }
}

export default { name, apply }