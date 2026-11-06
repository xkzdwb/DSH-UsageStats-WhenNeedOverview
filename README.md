# DSH-UsageStats-WhenNeedOverview

> 给 DSH 的 Web UI 加一个**用量统计面板**：token 用量、会话数、预估费用与预算、
> 用量时间线、单会话明细，以及 CPU 活动。数字全部来自你**真实的会话日志**，
> 不是估算。零依赖，只用 Node 内置模块。

面板里除了「价格」之外没有任何数字是编的：harness 每轮把
`assistant/message` 事件的 `usage` 写进 `~/.dsh/sessions/**/session.v4.jsonl.zstd`，
插件把这些记录折起来再算账。价格你在配置里填，改完立刻按新价重算全部历史。

- **给 DSH 用**：侧边栏多一个柱状图标（在「插件」「定时」之后），点开是主栏仪表盘。
- **给 CI 用**：`node test/run-tests.mjs` 是纯离线回归，不读 `~/.dsh`、不联网。
- **给你自己用**：`GET /plugin-usage-stats/data` 是一条只读 JSON 路由，也能直接用 curl 拿。

---

## 1. 面板里有什么

| 区块 | 内容 |
|---|---|
| 四个 KPI | 总 token（含输入/输出/缓存拆分）、会话数、模型调用次数、预估费用；第四格是预算进度 |
| Token 用量时间线 | 按小时（跨度超过 7 天自动按天）堆叠柱：缓存读取 / 输入 / 输出；绿线是每桶费用 |
| 按模型 | 每个 `provider/model` 的调用数、token、费用、相对花费条 |
| CPU 活动 | 进程 CPU（「单核百分比」和「占整机百分比」两条）、系统 CPU、进程内存、运行时长，外加 90 个采样点的走势线 |
| 会话明细 | 每个会话的调用数、token、费用、最后活动时间；可搜索、可排序、花费条对比 |

时间范围按钮（全部 / 24h / 7d / 30d）只影响**面板显示**；预算那格永远按预算周期
（本自然月或累计）算，不受范围按钮影响。

面板每 5 秒轮询一次（CPU 走势靠这个滚动）；点「刷新」会强制重读全部会话日志。

### 语言

面板右上角有一组三档开关：**自动 / 中文 / EN**（在时间范围按钮左边）。

- **自动**（默认）＝ 跟随 Harness 设的界面语言（Settings → General → Language，或浏览器语言）。
- **中文 / EN** ＝ 只把这个面板钉死成那种语言，**不动**其它界面文字。
- 选择存在浏览器 `localStorage` 的 `dsh-usage-stats:lang`，刷新、重开都还在；选回「自动」就删掉这条记录。
- 切语言不重新请求数据（数字与语言无关），只重渲染；千分位、日期、货币小数位也跟着切。
- 侧边栏那个图标的提示文字走同一个开关，但它在侧边栏下次重绘时才更新。
- 插件管理页那张卡片的标题/描述来自 `locale/*.json`，**永远跟随 Harness 语言**，不受这个开关影响。
- `localStorage` 不可用（隐私模式等）时开关照样能切，只是刷新后回到「自动」。

## 2. 文件

| 文件 | 作用 |
|---|---|
| [index.js](index.js) | Host 半边：折会话日志、算费用、采样 CPU、注册只读路由 |
| [client.js](client.js) | Client 半边：`sidebar.panellist` 图标 + `main` 仪表盘，只用 `--dsw-alias-*` 主题 token |
| [cordis.patch.yml](cordis.patch.yml) | 包自带的 patch：插入 `usage-stats` 行，配置全在这里 |
| [locale/en.json](locale/en.json)、[locale/zh.json](locale/zh.json) | 插件管理页显示用的 `meta.title` / `meta.description` |
| [icon.svg](icon.svg) | 面板与插件行图标（自绘，658 字节） |
| [test/run-tests.mjs](test/run-tests.mjs) | 离线回归：package 契约、Host 路由、计费、客户端 bundle、脏配置 |
| [tools/check-assets.mjs](tools/check-assets.mjs) | 静态资源自检：svg、locale、语法 |
| [examples/cordis.patch.snippet.yml](examples/cordis.patch.snippet.yml) | 装进 DSH 的两种写法 |

两个半球都**只用 `node:` 内置模块**（Host）或**浏览器共享模块表里的 `react`**（Client）：
按包名加载的插件解析不到额外的裸包名，所以这项目没有一条 `import` 指向 npm 包。

## 3. 先跑离线测试（10 秒，不需要装 DSH）

```powershell
cd <clone 下来的目录>
node test/run-tests.mjs
```

```
用例 1：package.json 是 DSH 认得的 bundle
  ok   名字不带 scope，能被 profile 当包名引用
  ...
用例 5：GET 返回快照，数字与手算一致
  ok   费用等于四类 token 各乘各价之和
  ok   费用不是「total × 单一价」的错算
  ...
全部通过
```

会话日志全在内存里造（照 DSH **真实的** `assistant/message` 事件形状：`data.usage` 是
`TokenUsage`（`inputTokens`/`outputTokens` 必有，`cacheReadTokens`/`cacheWriteTokens`/
`reasoningTokens` 可选），`data.message.source` 带 `provider`/`model`），不读你机器上的任何文件。
目前 **140 项检查**，另有 19 项静态检查：

```powershell
node tools/check-assets.mjs
```

两条都不联网、不读 `~/.dsh`，CI 里跑的就是它们。

## 4. 装进 DSH

插件是**包**的形态：`package.json` 里的 `dsh.bundle.patch` 指向自带的
`cordis.patch.yml`，profile 只要把这个包装上，面板和 Host 路由就一起挂好了——
不需要再手写 `name:` 行。完整片段见
[examples/cordis.patch.snippet.yml](examples/cordis.patch.snippet.yml)。

### 方式 A：作为包装进 profile（推荐）

在 `~/.dsh/profiles/<profile>/package.json` 里加一条依赖，并把包名加进 `bundles`：

```jsonc
{
  "dependencies": {
    "dsh-usage-stats": "link:P:/absolute/path/to/DSH-UsageStats-WhenNeedOverview"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-usage-stats"
      ]
    }
  }
}
```

`link:` 后面换成你本机的**绝对路径**（Windows 用正斜杠更稳）。这是硬链接而不是拷贝，
所以改了源码重启即生效，不用重新装。

`bundles` 的顺序就是加载顺序，它同时决定了 patch 的**叠加顺序**：DSH 按这个列表依次把每个
bundle 的 patch 铺到一个空列表上，最后才是 profile 自己的 `cordis.patch.yml`。所以本包必须排在
官方的 `dsh-base` / `dsh-web-app` 后面——它要用到那两个提供的 `webServer` 与 `sessionQuery`，
而且你在自己 patch 层里写的东西会盖在本包之上（想改预算/价格，直接改 profile 的 patch 也行）。

> 包名先按 DSH 安装目录解析，再按 profile 目录解析，profile 的 `node_modules` 里的 pnpm 条目优先。
> 所以要么让 pnpm 建好链接（`link:` 依赖装一次即可），要么把包名换成绝对路径入口。

### 方式 B：只往 patch 层插一行

不想动 profile 的 `package.json` 就手写一行，`name` 换成入口文件的绝对路径：

```yaml
- insert:
    - id: usage-stats
      name: "P:/absolute/path/to/DSH-UsageStats-WhenNeedOverview/index.js"
      config:
        budget: 200
        # …其余配置见 cordis.patch.yml
```

> 走方式 B 时侧边栏/主栏那两个槽**不会自动注册**——它们由 `package.json` 里的 `dsh.client`
> 声明驱动，只有把包列进 `dsh.profile.bundles` 才会生效。只想用那条 JSON 路由、不要界面的话选 B
> 就行；要面板就选 A。

改完**重启 DSH**（Host 半边在启动时装载）。重启后 HOST 日志里会出现：

```
[usage-stats] serving GET /plugin-usage-stats/data
```

然后在 Web UI 侧边栏点那个柱状图标，主栏就会出面板。

### 验证它真的在跑

```powershell
curl.exe -i http://127.0.0.1:<DSH 的端口>/plugin-usage-stats/data
```

应当看到 `200`、`content-type: application/json`、`cache-control: no-store`，正文是一坨计数字段
（不含任何消息正文）。`GET /plugin-usage-stats/data?refresh=1` 强制重读日志，
`?days=7` 只看最近 7 天（`0` = 全部）。

## 5. 配置项

全部在 patch 的 `config:` 下。价格单位是**每 100 万 token**：

| 字段 | 默认 | 说明 |
|---|---|---|
| `currency` | `CNY` | 币种。`CNY`/`USD`/`EUR`/`JPY`/`GBP` 用内置符号，其它币种显示成「数字 + 代码」 |
| `budget` | `200` | 预算额度；`0` = 只显示花费，不显示进度 |
| `budgetPeriod` | `month` | `month` = 本自然月；`all` = 全部历史 |
| `cacheTtlMs` | `30000` | 折叠缓存有效期。非 live 会话只读一次，live 的每次刷新都重读 |
| `cpuSampleIntervalMs` | `2000` | CPU 采样间隔（夹在 500–60000ms） |
| `cpuHistoryLength` | `90` | 走势图保留多少个采样点（夹在 10–600） |
| `maxSessions` | `2000` | 最多统计多少个会话（代码里的默认值，patch 里没写就是它） |
| `maxConversations` | `300` | 明细最多列多少条（夹在 10–5000），按花费降序 |
| `pricing.default` | 见下 | 所有模型的兜底单价 |
| `pricing.models` | `{}` | 按 `provider/model`（或只写 `model`）覆盖，优先级高于 `default` |

```yaml
pricing:
  default:
    input: 2
    output: 8
    cacheRead: 0.5
    cacheWrite: 2
  models:
    some-provider/some-model:
      input: 1
      output: 4
      cacheRead: 0.25
      cacheWrite: 1
```

> ⚠️ **`default` 里的数字是占位值**，按 DeepSeek 官方列表价的形状填的，不是你的实付价。
> 你要是走中转或聚合网关，单价只有你自己知道，请按实付价改。改完不必清缓存：
> 折叠出来的中间结果**只存 token 计数、不存费用**，价格一改，历史立刻按新价重算。

键照会话日志里 `message.source` 的原样写，形如 `provider/model`——例如
`<你的 provider 名>/<你的 model id>`；只写 `model` 部分也能匹配。不知道确切的写法就先开一次
`GET /plugin-usage-stats/data?days=0`，返回里 `byModel[].key` 就是日志里的原样键。

## 6. 数据怎么来的

```
sessionQuery.listSessions()            → 列出全部会话（跨工作区）
sessionQuery.readSession(id)           → 每个会话的完整事件日志
  └─ assistant/message + data.usage    → inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens
  └─ data.message.source               → provider / model（计费按这个分）
sessionQuery.readTitleSnapshots(ids)   → 会话标题
```

两个关键点，也是这个插件最容易写错的地方：

1. **`totalTokens` 把缓存读取算进去了**（`total = input + output + cacheRead + cacheWrite`），
   所以计费必须四类 token **各乘各的价**，不能拿 `totalTokens` 乘一个单价。
   `test/run-tests.mjs` 里专门有一条检查就是防这个错算。
2. **非 live 的会话只折一次**，live 的每次刷新都重读；中间结果只存「按模型 / 按小时」的
   token 计数，**不存费用**。

Host 半边把这些折成一个 JSON，挂在一条只读路由上：

```
GET /plugin-usage-stats/data?days=0&refresh=0
```

路由是 `exact` 类型，只答这一个路径；只允许 `GET`/`HEAD`（其它方法 `405` 且带 `allow` 头）；
响应带 `cache-control: no-store`。**不返回任何消息正文**，只有计数和标题。

### 为什么用 HTTP 路由，而不是 `host.call`

`host.call` 是**动态包**（`cordis_define`/`cordis_run` 那种，进程内、重启即失效、需要审批）才有的桥；
生成式 Remote 命名空间又没法从一个「按包名加载的插件」里扩展。已安装 bundle 的浏览器半边只是
普通的 Cordis 客户端插件，所以这里用 Host 已有的 `webServer.register()` 开一条只读路由——
这条通道不需要任何代码生成，也不会碰其它插件的路由。

## 7. 排错

| 现象 | 原因与处理 |
|---|---|
| 侧边栏没有那个图标 | 没按方式 A 装（缺 `dsh.client` 就只挂路由不挂界面）；或没重启 DSH |
| 面板是空的/一直转 | 路由 404：确认 HOST 日志里有 `serving GET /plugin-usage-stats/data`；确认装法带了 `webServer` 服务（官方 `dsh-web-app` bundle 会提供） |
| 费用明显不对 | `pricing` 还是占位价；或模型名没对上（用 `?days=0` 看返回里 `byModel[].key` 的真实写法，照它填 `models`) |
| 数字停在几分钟前 | 非 live 会话有 `cacheTtlMs` 缓存；点「刷新」或加 `?refresh=1` 立即对齐 |
| 改了 `client.js` 但界面没变 | 客户端 bundle 带 `rev` 查询串，**刷新一次页面** |
| 面板内容被裁掉、滚不动 | 面板自己就是滚动容器（`.us-root { height:100%; overflow:auto }`）。`main` 槽不替条目滚动，别把 `overflow` 删了 |

## 8. 已知边界

- 时间线分桶按 **UTC 整点**对齐；东八区整点与 UTC 整点重合，所以这里看不出差别，
  换成半小时时差的时区就会错位。
- 预算周期只支持「本自然月」和「全部」，没有「近 30 天」。
- 「会话数」把子代理会话也算进去（明细里带 `子代理` 徽标，KPI 里不单列）。
- 折叠缓存只按 live/非 live 区分：一个会话停了之后又被恢复，最多滞后一个 `cacheTtlMs`，
  点「刷新」可立即对齐。
- 金额一律四舍五入到 **4 位小数**（宿主侧）；面板显示时 ≥1 的金额取 2 位、<1 取 4 位。
- CPU 采样用 `process.cpuUsage()` 与 `os.cpus()` 的差值，**只反映 HOST 进程本身**，
  不是整机的其它进程明细。

## 9. 已验证 / 未验证

已验证（离线，`node test/run-tests.mjs` 140 项 + `node tools/check-assets.mjs` 19 项，全绿）：

- package 契约：入口、`dsh.bundle.patch`、`dsh.client`、`exports`/`files` 白名单、零依赖。
- Host 半边：`exact` 路由注册与卸载、`GET`/`HEAD`/`405`、`cache-control`、
  `content-length` 与正文一致、缓存命中不重读、`refresh=1` 强制重读、`days` 范围过滤、
  `days=abc` 脏参数兜底。
- 计费：四类 token 分乘各自的价（且证明不是「total × 单一价」）、模型级覆盖、
  只写 `model` 的键也命中、未覆盖字段回退 `default`。
- 聚合：会话数/根会话/子代理/调用数/消息数（无 `usage` 的事件不计调用但计消息）、
  按模型降序、明细按花费降序、时间线按小时分桶。
- 容错：单个会话读失败时跳过并记进 `errors`、路由仍 `200`；八种脏配置都不抛。
- 客户端：在 `vm` 里按 `__ModuleLoader__` 契约加载，验证注册进 `sidebar.panellist`（id `usage-stats`）
  与 `main`（key `usage-stats`）、locale 词条 en/zh **key 完全对齐**、
  CSS 变量**全部**是 `--dsw-alias-*`、请求只走自己的路由且带 `no-store` / `same-origin`。
- 仓库存量：六个运行时文件里没有绝对路径、没有 token/key、没有真实邮箱。

**没能验证的**：面板的最终视觉呈现。测试能证明「模块加载了、槽注册了、词条齐了」，
不等于像素上好看——请自己点开侧边栏那个柱状图标确认，尤其是浅色主题下的对比度。

> 本仓库最初是从一个本机可用的版本整理出来的，发布时 `client.js` 里那行 `__ModuleLoader__.load({ id })`
> 从 `@local/dsh-usage-stats` 改成了包名 `dsh-usage-stats`（否则客户端 id 会和包名对不上）。
> 除这一行外，`index.js` / `client.js` / `icon.svg` / `locale/*.json` 与装机版本逐字节相同。

## License

[MIT](LICENSE)
