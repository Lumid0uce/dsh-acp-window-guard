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
 *      MIN_ASSUMED_WINDOW_TOKENS 兜底”的补丁，让超窗请求在本地被 422 拒掉而不是裸发；
 *   3) 把 provider 的 loopback baseURL 改写成走 ACP 的 /bili/ 重写通道 —— 请求的物理目标
 *      变成 ACP，即使宿主那层 fetch 钩子某一轮没触发，也不会再有“裸发不压缩”；
 *   4) 运行时再补一刀：在自己的 fetch 包装里把漏改写的模型请求也指向 ACP /bili/ 通道。
 *
 * 全部操作失败都只记日志、不抛异常，绝不影响宿主启动。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'acp-window-guard'

const DEFAULT_MIN_CONTEXT_LIMIT = 1_000_000
// ACP 0.1.212 与 0.1.213 把这个“窗口未知即哑火”的判断函数改了名字，两套都要覆盖：
//   0.1.212: bodyProvablyOverWindow2(body,init,declaredWindow)
//   0.1.213: bodyOverWindowDetail2(body,init,declaredWindow)  （内部多了 CALIBRATED_TEXT_TOKEN_RATIO）
const CALL_PATTERNS = [
  {
    from: 'bodyProvablyOverWindow2(body,init,effectiveContextWindow(ctx))',
    to: 'bodyProvablyOverWindow2(body,init,effectiveContextWindow(ctx)??MIN_ASSUMED_WINDOW_TOKENS)',
  },
  {
    from: 'bodyOverWindowDetail2(body,init,effectiveContextWindow(ctx))',
    to: 'bodyOverWindowDetail2(body,init,effectiveContextWindow(ctx)??MIN_ASSUMED_WINDOW_TOKENS)',
  },
]
const OLD_CALL = CALL_PATTERNS[0].from
const NEW_CALL = CALL_PATTERNS[0].to

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
      let pending = 0
      let already = 0
      let shape = ''
      for (const p of CALL_PATTERNS) {
        const n = text.split(p.from).length - 1
        const d = text.split(p.to).length - 1
        if (n > 0) { pending += n; shape = p.from }
        already += d
      }
      if (pending === 0 && already >= 2) return { ok: true, changed: false, patched: already, file }
      if (pending === 0) return { ok: false, changed: false, reason: 'pattern not found (bundle 结构已变，需人工复核)', file }
      if (config.dryRun) return { ok: true, changed: false, wouldChange: true, callSites: pending, shape, file }
      const backup = `${file}.bak-window-guard-${stamp()}`
      fs.copyFileSync(file, backup)
      let next = text
      for (const p of CALL_PATTERNS) next = next.split(p.from).join(p.to)
      fs.writeFileSync(file, next, 'utf8')
      log(`[acp-window-guard] ACP 超窗保险补丁已重打（${pending} 处）: ${file} (backup: ${path.basename(backup)}); 重启 ACP 代理后生效`)
      return { ok: true, changed: true, callSites: pending, backup, file }
      fs.writeFileSync(file, next, 'utf8')
      log(`[acp-window-guard] ACP 超窗保险补丁已重打（${raw} 处）: ${file} (backup: ${path.basename(backup)}); 重启 ACP 代理后生效`)
      return { ok: true, changed: true, callSites: raw, backup, file }
    } catch (err) {
      log(`[acp-window-guard] 补丁处理失败（不影响启动）: ${err?.message ?? err}`)
    }
  }
  return { ok: true, changed: false, reason: `未找到 ACP bundle（查过 ${tried.length} 个候选路径）` }
}

/** 3) 把 provider 的 loopback baseURL 改写成走 ACP 的 /bili/ 重写通道
 *
 * 背景（2026-11 实测）：宿主是用 “在进程内 patch globalThis.fetch，把 URL 改写成
 * {ACP代理}/bili/{原始URL}” 的方式把模型请求送进 ACP 的。这条钩子在某些轮次
 * （实测：手机入口触发的轮次）没有触发，请求就带着原始 baseURL 直连上游，
 * ACP 完全看不到 → 不压缩、无任何日志 → 超过上游窗口时 400（prompt is too long）。
 *
 * 把 baseURL 直接写成 {ACP代理}/bili/{原始baseURL} 之后，请求的物理目标就是 ACP，
 * 钩子是否触发都绕不过去；钩子没触发时只是少一个 x-bili-plugin-context-window 头，
 * 代理会退回 modelContextLimit（配合本插件第 1 项已是 1,000,000）。
 * 实测：直接打 {ACP代理}/v1/... 是 403，打 {ACP代理}/bili/{原始URL} 是 200。
 */
export function proxyOrigin(config = {}) {
  const file = config.proxyOriginFile
    ?? process.env.BILI_PROXY_ORIGIN_FILE
    ?? path.join(os.homedir(), '.local', 'state', 'billion-context', 'proxy-origin')
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof j?.origin === 'string' && /^https?:\/\//.test(j.origin)) return { origin: j.origin, file, pid: j.pid }
  } catch {}
  return undefined
}

export function dshSettingsPath(config = {}) {
  return config.dshSettingsFile
    ?? process.env.DSH_SETTINGS
    ?? path.join(os.homedir(), '.dsh', 'settings.yaml')
}

const LOOPBACK = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//i

export function ensureProxyBaseUrl(config = {}, log = console.log) {
  const want = config.rewriteBaseUrl === true || config.rewriteBaseUrl === '1' || process.env.ACP_GUARD_BASEURL === '1'
  if (!want) return { ok: true, changed: false, reason: 'disabled (默认关闭；运行时 fetch bridge 已覆盖此场景。需要时设 ACP_GUARD_BASEURL=1)' }
  const proxy = proxyOrigin(config)
  if (!proxy) return { ok: true, changed: false, reason: 'no ACP proxy-origin (ACP not running?)' }
  const file = dshSettingsPath(config)
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return { ok: true, changed: false, reason: 'cannot read ' + file } }
  const hits = []
  const next = text.replace(/^(\s*baseURL:\s*)(\S+)(\s*)$/gm, (m, head, url, tail) => {
    if (!LOOPBACK.test(url)) return m
    if (url.includes('/bili/')) return m
    if (url.startsWith(proxy.origin)) return m
    hits.push(url)
    return head + proxy.origin + '/bili/' + url + tail
  })
  if (hits.length === 0) return { ok: true, changed: false, reason: 'nothing to rewrite' }
  if (config.dryRun) return { ok: true, changed: false, wouldChange: true, hits, file }
  try {
    const backup = file + '.bak-guard-' + stamp()
    fs.copyFileSync(file, backup)
    fs.writeFileSync(file, next, 'utf8')
    log('[acp-window-guard] baseURL -> ACP /bili/ channel: ' + hits.join(', ') + ' (backup: ' + path.basename(backup) + '); restart DSH to take effect')
    return { ok: true, changed: true, hits, backup, file }
  } catch (err) {
    log('[acp-window-guard] baseURL rewrite failed (ignored): ' + (err?.message ?? err))
    return { ok: false, changed: false, error: String(err?.message ?? err) }
  }
}

/** 4) 运行时兜底：如果宿主那层 fetch 钩子没有把模型请求改写成 ACP 的 /bili/ 通道，
 *    我们自己在 fetch 层补一刀，保证请求的物理目标一定是 ACP 代理。
 *
 * 为什么需要：ACP 靠 patch globalThis.fetch 来改写 URL，实测手机上来的某些轮次这条
 * 钩子没有触发（bili.log 里那一轮 0 行日志，上游直接 400 prompt is too long）。
 * 这里挂一层自己的 fetch：只对“模型端点 + 目标是 loopback/非 ACP”的请求改写成
 * {origin}/bili/{原始URL}；已经被 ACP 改写过的（本来就在 origin 下）原样放行。
 */
const MODEL_ENDPOINT = /\/(chat\/completions|completions|responses|messages)(\?|$)/i

export function installFetchBridge(config = {}, log = console.log) {
  const g = globalThis
  if (config.fetchBridge === false) return { ok: true, installed: false, reason: 'disabled' }
  if (g.__acpWindowGuardFetchBridge) return { ok: true, installed: false, reason: 'already installed' }
  const proxy = proxyOrigin(config)
  if (!proxy) return { ok: true, installed: false, reason: 'no ACP proxy-origin (ACP not running?)' }
  const origin = proxy.origin
  const origFetch = g.fetch
  if (typeof origFetch !== 'function') return { ok: true, installed: false, reason: 'globalThis.fetch missing' }
  g.fetch = function acpGuardFetch(input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && typeof input.url === 'string' ? input.url : '')
      if (url && MODEL_ENDPOINT.test(url) && !url.startsWith(origin)) {
        const next = origin + '/bili/' + url
        if (typeof input === 'string') {
          return origFetch.call(this, next, init)
        }
        try {
          return origFetch.call(this, new Request(next, input), init)
        } catch {
          return origFetch.call(this, next, init)
        }
      }
    } catch {}
    return origFetch.apply(this, arguments)
  }
  g.__acpWindowGuardFetchBridge = { origin, at: new Date().toISOString() }
  log('[acp-window-guard] fetch bridge installed -> ' + origin + '/bili/ (model requests cannot bypass ACP anymore)')
  return { ok: true, installed: true, origin }
}

export function runGuard(config = {}, log = console.log) {
  const limit = ensureContextLimit(config, log)
  const patch = ensureBundlePatch(config, log)
  const baseUrl = ensureProxyBaseUrl(config, log)
  const bridge = installFetchBridge(config, log)
  return { limit, patch, baseUrl, bridge }
}

export function apply(ctx, config = {}) {
  const sink = typeof ctx?.logger?.info === 'function'
    ? (m) => ctx.logger.info(m)
    : (...a) => console.log(...a)
  try {
    const r = runGuard(config, sink)
    try {
      const logDir = path.join(os.homedir(), '.dsh', 'logs')
      fs.mkdirSync(logDir, { recursive: true })
      fs.appendFileSync(path.join(logDir, 'acp-window-guard.log'), JSON.stringify({
        t: new Date().toISOString(),
        limit: r.limit?.changed ? 'patched' : (r.limit?.current ?? (r.limit?.ok ? 'ok' : 'error')),
        bundle: r.patch?.changed ? 'patched' : (r.patch?.ok ? 'ok' : 'attention'),
        bridge: r.bridge?.installed ? 'installed:' + r.bridge.origin : (r.bridge?.ok ? 'ok' : 'attention'),
        baseUrl: r.baseUrl?.changed ? 'rewritten' : (r.baseUrl?.reason ?? 'ok'),
      }) + '\n', 'utf8')
    } catch {}
    sink(`[acp-window-guard] 就绪: contextLimit=${r.limit.changed ? 'patched' : (r.limit.error ? 'error' : 'ok')}, bundle=${r.patch.changed ? 'patched' : (r.patch.ok ? 'ok' : 'attention')}, baseURL=${r.baseUrl.changed ? 'rewritten' : (r.baseUrl.ok ? 'ok' : 'attention')}, bridge=${r.bridge.installed ? 'installed' : (r.bridge.ok ? 'ok' : 'attention')}`)
    return r
  } catch (err) {
    sink(`[acp-window-guard] 整体失败（已忽略）: ${err?.message ?? err}`)
    return { ok: false }
  }
}

export default { name, apply }