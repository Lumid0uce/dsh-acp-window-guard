# CHANGELOG

## 0.2.1

- 兼容 billion-context **0.1.213**：上游把窗口判断函数从 `bodyProvablyOverWindow2` 改名为
  `bodyOverWindowDetail2`（内部新增 `CALIBRATED_TEXT_TOKEN_RATIO` 校准），0.2.0 的字符串补丁在
  0.1.213 上会 `pattern not found` 而静默失效。现在两套函数名都覆盖，且报告里会带命中的形状。
- 幂等校验改成按「每个模式各自的 from/to 计数」判断，避免换版本后误判 `already patched`。
## 0.2.0 — 2026-11-08

新增「请求进不了 ACP」这一类故障的护栏。

- **新增 `installFetchBridge()`（核心）**：在 `globalThis.fetch` 上挂一层包装，凡是打到模型端点
  （`/chat/completions`、`/completions`、`/responses`、`/messages`）且目标不是 ACP 代理的请求，
  一律改写成 `{ACP代理}/bili/{原始URL}`。ACP 自己的拦截钩子没触发时，请求也能被压缩，不再裸发。
- 新增 `ensureProxyBaseUrl()`（默认关闭，`ACP_GUARD_BASEURL=1` 开启）：配置层把 provider 的
  loopback `baseURL` 直接改写成 `/bili/` 通道。**注意**：DSH 桌面端退出/保存配置时会把
  `settings.yaml` 写回，该项可能被覆盖，所以默认不开，交给运行时 fetch bridge 兜底。
- 新增导出：`proxyOrigin()`、`dshSettingsPath()`。
- 修正：`runGuard()` 现在返回 `{ limit, patch, baseUrl, bridge }`。

背景（实测）：某轮手机消息触发的模型调用没有经过 ACP 的 fetch 钩子，请求带着原始 baseURL
直连上游，`bili.log` 里该轮 0 行记录；历史 145 万 / 248 万 / 335 万 token 的裸发 400 都是这么来的。

## 0.1.0 — 2026-11-08

首个版本：抬 `modelContextLimit` 到 1,000,000；重打 `bodyProvablyOverWindow2(...)??MIN_ASSUMED_WINDOW_TOKENS` 两处补丁。

## 0.2.1

- 兼容 billion-context **0.1.213**：上游把窗口判断函数从 `bodyProvablyOverWindow2` 改名为
  `bodyOverWindowDetail2`（内部新增 `CALIBRATED_TEXT_TOKEN_RATIO` 校准），0.2.0 的字符串补丁在
  0.1.213 上会 `pattern not found` 而静默失效。现在两套函数名都覆盖，且报告里会带命中的形状。
- 幂等校验改成按「每个模式各自的 from/to 计数」判断，避免换版本后误判 `already patched`。
