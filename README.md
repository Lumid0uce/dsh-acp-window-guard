# dsh-acp-window-guard

给 **billion-context（ACP）** 的窗口估算兜底，治这两个症状：

- `Error: {"code":11115,"msg":"prompt is too long: N tokens > 1048576 maximum"}`（N 动辄一百多万甚至三百万）
- 或者不报错，但一条消息发出去 15 秒没有第一个字，然后失败

## 为什么会这样

ACP 的「可用窗口」= `contextWindow − maxTokens`，而 `contextWindow` 有两种来源：

| 来源 | 数值 | 结果 |
|---|---|---|
| 宿主透传 `x-bili-plugin-context-window` 头 | 1,000,000 − 128,000 | **872,000**，压缩到十几万，正常 |
| 拿不到头（匿名链 `pfa-*`、插件注入路径、子代理/后台车道的部分调用） | 配置文件默认 `200000` − 预留 `32768` | **167,232**，压缩到 32 万仍判超窗 → 「forwarding once for the upstream to arbitrate」→ 上游 400 |

再加上第二个坑：ACP 里 `bodyProvablyOverWindow(bodyBytes, rawBody, declaredWindow)` 开头有

```js
if (bodyBytes === undefined || declaredWindow === undefined) return undefined
```

`declaredWindow` 缺失时，**本地超窗保险整条哑火**，1.45M token 的请求就这样原样发出去。

所以：窗口算小了 → 压缩目标错了 → 拒发保险又没电 → 裸发 → 400。

## 这个插件做什么

启动时跑两件事，**全部幂等**：

1. 把 `~/.config/billion-context/billion-context.json` 的 `modelContextLimit` 抬到 `minContextLimit`（默认 `1000000`），改前备份 `.bak-window-guard-<ts>`。
2. 在 `billion-context/dist/agent/dsh-native.js` 里把两处
   `bodyProvablyOverWindow2(body,init,effectiveContextWindow(ctx))`
   补成 `…effectiveContextWindow(ctx)??MIN_ASSUMED_WINDOW_TOKENS)`
   —— 窗口未知时按 1M 兜底，可证超窗的请求在**本地 422 拒掉**，不再裸发（上游升级覆盖了补丁就自动重打）。

全程 `try/catch`：任何一步失败只写日志，**绝不阻塞宿主启动**。

## 安装

```bash
git clone https://github.com/Lumid0uce/dsh-acp-window-guard.git
```

然后把它挂进 DSH 的 profile（示例：Windows 桌面版默认 profile 是 `desktop`；macOS/Linux 换成你的 profile 目录名）：

```powershell
# 1) 放进 profile 的 node_modules（Windows 用 junction，Unix 用 ln -s）
$src = "C:\path\to\dsh-acp-window-guard"
$dst = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-acp-window-guard"
New-Item -ItemType Junction -Path $dst -Target $src

# 2) 在 ~/.dsh/profiles/desktop/package.json 里
#    dependencies 增加："dsh-acp-window-guard": "link:<上面 $src 的路径>"
#    dsh.profile.bundles 数组里追加："dsh-acp-window-guard"
```

改完 `package.json` 记得先备份一份。

## 生效

两件事都只在 **ACP 代理下次启动** 时起作用：

1. 退出 DSH 桌面端（它退出时会把自己的插件 bundle 写回，必须它先退）。
2. 杀掉旧 ACP 代理，重新拉一个：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'billion-context' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 2
node "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\billion-context\dist\index.js" start --host 127.0.0.1 --port 18790
```

3. 重开 DSH。

## 验证

看 ACP 日志 `~/.local/state/billion-context/bili.log`：

- 窗口数字：匿名链应该从 `167232` 变成约 **`967232`**（1,000,000 − 32,768）；有归因的会话仍是 `872000`。
- 保险是否生效：裸发被拦下的那次会有本地 422，响应头 `x-bili-gate: oversize-refusal-unattributed`。

## 配置

`cordis.patch.yml` 里 `config: {}` 可填：

| 键 | 默认 | 说明 |
|---|---|---|
| `minContextLimit` | `1000000` | 期望的最小窗口 |
| `patchAcpCode` | `true` | 是否维护 `dsh-native.js` 补丁 |
| `dryRun` | `false` | 只报告，不落盘 |
| `configFile` | 自动 | 覆盖 ACP 配置路径（也认 `BILI_CONFIG_FILE` / `XDG_CONFIG_HOME`） |
| `acpBundlePath` | 自动 | 覆盖 `dsh-native.js` 路径 |

## 回滚

```powershell
# 配置
Copy-Item "$env:USERPROFILE\.config\billion-context\billion-context.json.bak-window-guard-*" `
          "$env:USERPROFILE\.config\billion-context\billion-context.json" -Force
# 代码补丁
Copy-Item "<...>\billion-context\dist\agent\dsh-native.js.bak-window-guard-*" `
          "<...>\billion-context\dist\agent\dsh-native.js" -Force
```

不想让插件动代码，就把 `patchAcpCode` 设为 `false`。

## 上游修复状态

两个 bug 已报给上游并在修：

- issue: https://github.com/ranxianglei/billion-context/issues/5907
- PR:  https://github.com/ranxianglei/billion-context/pull/5910

PR 合入并升级 billion-context 之后，**这个插件就可以卸掉**：那时 `modelContextLimit` 留着无害，而 bundle 补丁反而会和上游修复重叠（插件会报 `pattern not found`，不抛错）。

## 手工等价物

不想装插件，也可以直接跑脚本（幂等）：

- Windows: `pwsh scripts/reapply-acp-window-patch.ps1`（`-CheckOnly` 只查不改）
- macOS / Linux: `bash scripts/reapply-acp-window-patch.sh`（`--check` 只查不改）

## License

MIT
## 0.2.0 新增：把"进不了 ACP"的请求钉回代理

有些人（包括作者本机）遇到的报错不是"压缩不够"，而是**某些轮次的模型调用根本没经过 ACP**：
`bili.log` 里那一轮一行记录都没有，请求带着原始 `baseURL` 直接打上游，
历史 145 万 / 248 万 / 335 万 token 的 `prompt is too long` 都是这么出去的。
实测触发场景：从手机端 App 发起的消息，偶发（同一会话有的轮次漏、有的不漏）。

原因：ACP 是用「在宿主进程里 patch `globalThis.fetch`，把 URL 改写成
`{ACP代理}/bili/{原始URL}`」的方式接管请求的。这条钩子没生效时，请求就绕过去了。

本插件从 0.2.0 起在 `globalThis.fetch` 上再挂一层（`installFetchBridge`）：
凡是模型端点（`/chat/completions`、`/completions`、`/responses`、`/messages`）
且目标不是 ACP 的请求，一律改写成 `{ACP代理}/bili/{原始URL}`。
ACP 钩子生效时它什么都不做（URL 已经在代理域下），失效时它兜底。

验证过的通道性质（2026-11 实测）：

```bash
# 直连代理的非 /bili/ 路径 → 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' -d '{"model":"x","messages":[]}' \
  http://127.0.0.1:18790/v1/chat/completions     # → 403 Request not allowed

# /bili/ 重写通道 → 200，且照常压缩、照常计费统计
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' -d '{"model":"x","messages":[]}' \
  'http://127.0.0.1:18790/bili/http://127.0.0.1:8888/v1/chat/completions'   # → 200
```

安装后 `~/.dsh/logs/` 无关；启动日志里会多一行：

```
[acp-window-guard] fetch bridge installed -> http://127.0.0.1:18790/bili/ (model requests cannot bypass ACP anymore)
```

### 配置层改写（默认关闭）

`ensureProxyBaseUrl()` 也能直接把 `~/.dsh/settings.yaml` 里 provider 的 loopback `baseURL`
改成 `/bili/` 通道。但 **DSH 桌面端退出/保存配置时会把 `settings.yaml` 写回去**，
改了会被覆盖、还会反复生成备份，所以默认不开：

```bash
ACP_GUARD_BASEURL=1   # 想用再开
```

日常只需要运行时 fetch bridge 即可。

### 关闭某一项

```js
// cordis.patch.yml 的 config 里
{ id: acp-window-guard, name: 'dsh-acp-window-guard', config: { fetchBridge: false } }  // 关 fetch 兜底
                                                                                        // rewriteBaseUrl 默认就是关的
```