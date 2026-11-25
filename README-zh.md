# dsh-lceda

[English](README.md) | 中文

DeepSeek Harness 的 **嘉立创 EDA（LCEDA 专业版）** 无头开发插件：让 agent 在真实
`.eprj3` 工程上执行编辑器 JavaScript、用 Freerouting 自动布线、核对 DRC / 焊盘网表 /
连通性、铺铜、画原理图导线、导出生产文件。

封装 LCEDA 专业版 CLI（`invoke --code-file -` 走 stdin，不落 UNC 临时文件）。
内置护栏：用户 GUI 占用工程时拒绝写操作（`.eprj3` 双向同步）、回收僵尸无头会话、
等待文档就绪、UTF-16LE CSV 导出自动解码，且绝不把 `ok:true` 当作业务成功。

## 安装

需要 DSH >= 0.2.2（Cordis 4）、Node >= 22.19，以及 Windows 上的 LCEDA 专业版（DSH 桌面端原生
运行和 WSL 里运行都支持：exe 路径自动探测，`sesDirWin` 只在 WSL 下翻译成 `/mnt/<盘>`）。发行包已带构建产物 `lib/`，安装时不跑构建脚本。

```sh
# 从本地检出安装
dsh plugin --profile <profile> add /path/to/dsh-lceda
# 从 git 安装（构建产物已入库）
dsh plugin --profile <profile> add git+https://github.com/samuelwhg/dsh-lceda.git
```

重启该 profile。bundle 的 `cordis.patch.yml` 会插入 `dsh-lceda` 这一行，八个 `lceda_*`
工具与 `lceda-dev` skill 自动出现，无需手改配置。

## 让 AI 自己装

把下面这段整块交给一台能在 DSH 所在机器上执行命令的 AI——它会装好、配好并冒烟验证，
不用你自己去找文档 id：

> 安装 `dsh-lceda` 插件，并让它在我的工程上跑通。
>
> 1. 先查前置条件：`node -v`（>= 22.19）、`dsh --version`（>= 0.2.2），以及本机是否装了
>    LCEDA 专业版。问清我要装进哪个 DSH profile。
> 2. 装 `gh` CLI——`lceda_report` 用它查和报 issue。可选（没装也能用：插件仍会本地记录并给你
>    预填好的 issue 链接），但这是用户机器上最常缺的一个依赖：先 `gh --version`；缺就
>    Windows 用 `winget install --id GitHub.cli`，WSL/Linux 用 `sudo apt install gh`（或下
>    release tarball 放进 `~/.local/bin`），macOS 用 `brew install gh`。然后让我执行一次
>    `gh auth login`（或把 token 喂给 `gh auth login --with-token`），并确认该账号能在
>    `reportRepo` 里开 issue。
> 3. 装进该 profile——从 git：
>    `dsh plugin --profile <profile> add git+https://github.com/samuelwhg/dsh-lceda.git`
>    （本地目录则 `add /path/to/dsh-lceda`）。装完确认 bundle 插入了 `id: dsh-lceda` 那一行。
> 4. 问我要 `.eprj3` 工程路径，以及这个 DSH 的同一个工作区里是否放着多个工程。`exePath` 与
>    `spawnCwd` 留空——会按各盘 `Program Files{, (x86)}\lceda-pro` 自动探测。只有我说 LCEDA
>    装在非常规位置时才显式设 `exePath`。
> 5. 一般什么都不用写：在工程文件夹里开会话，插件就用那里唯一的 `.eprj3`。只有工作区里有多个
>    工程（或我要从别处打开工程）时，才把 `projectPath` 写进 `<profile>/cordis.patch.yml` 里
>    已有的 `id: dsh-lceda` 行——合并进那一行，绝不要再加一行。`pcbUuid` / `schUuid` 留空即可：
>    插件会自动取工程文件里的第一块板 / 第一张原理图页。只有工程里有多块板、多页原理图且我要
>    指定某个时才填——id 就是 `.eprj3`（纯 JSON）里 `profile.pcbs` / `profile.sheets` 的键名。
>    只有我要自动布线时才加 `freeroutingJar` + `sesDirWin`。
> 6. 重启 profile 后验证，逐条原样回报结果：
>    `lceda_session {"action":"list"}`（证明能定位到 exe；失败时报错会列出探测过的每个路径）、
>    `lceda_session {"action":"open"}`（必须返回 session id）、
>    `lceda_run {"code":"return Object.keys(eda).filter(k=>k.startsWith('pcb_')).length"}`
>    （PCB API 面必须返回正整数）。
> 7. 到这一步就停，别动设计。`lceda_check` 和 `lceda_export` 是只读的；`lceda_run`、
>    `lceda_pour`、`lceda_sch_wire`、`lceda_sch_netlist`、`lceda_route` 会改文件——先告诉我你
>    准备跑什么，等我确认。
>
> 任何一步失败，原样贴报错，不要自己猜着改：所有失败信息都带你下一步该干什么和
> README 锚点。最常见原因是残留会话——`lceda_session {"action":"clean"}` 后重试一次。

## 配置

多数工程**什么都不用配**：在工程文件夹里开会话，插件就用那里唯一的 `.eprj3`（最多向下找两层），
并从它推导文档 id。只有一个工作区里放着多个工程时才需要设 `projectPath`；自动布线还要
`freeroutingJar` / `sesDirWin`。这些值写在装插件的那条 profile 行上，`id` 与 bundle 插入的相同
（`pcbUuid` / `schUuid` 留空会从工程文件里自动取，多板 / 多页时再显式指定）：

```yaml
# <profile>/cordis.patch.yml
- id: dsh-lceda
  name: dsh-lceda
  config:
    projectPath: D:\work\board.eprj3                       # Windows 路径，无头打开
    # pcbUuid / schUuid：可选，留空即从 projectPath 取第一块板 / 第一张原理图页
    freeroutingJar: /home/me/freerouting/freerouting.jar   # 仅 lceda_route 需要
    sesDirWin: D:\work\autoroute                           # 仅 lceda_route 需要
```

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `exePath` | *（空）* | `lceda-pro.exe` 的路径：WSL `/mnt/d/Program Files/…`，或 Windows 原生 `D:\Program Files\…`。留空即自动探测：各盘的 `Program Files{, (x86)}`（WSL 扫 `/mnt/<盘>`，Windows 扫存在的 `C:`–`Z:`），装在 D:/E: 也能找到 |
| `spawnCwd` | *（空）* | 启动 Windows exe 的 cwd；留空取 `exePath` 所在盘根（盘根可避开 UNC cwd 问题） |
| `projectPath` | *（空）* | 无头打开的 Windows `.eprj3`；留空即取会话工作区里唯一的 `.eprj3`，有多个时才设 |
| `pcbUuid` | *（空）* | `openDocument` 前奏用的 PCB 文档 id；留空即取 `projectPath` 工程里的第一块板 |
| `schUuid` | *（空）* | `openDocument` 前奏用的原理图页 id；留空即取 `projectPath` 工程里的第一张原理图页 |
| `freeroutingJar` | *（空）* | Freerouting jar，`lceda_route` 必需 |
| `javaBin` | `java` | Freerouting 用的 Java |
| `sesDirWin` | *（空）* | 导入用的 `board.ses` 落盘目录（Windows 可见），`lceda_route` 必需 |
| `workDir` | `.dsh-lceda` | DSN/SES/导出产物的本地目录，相对会话工作区 |
| `invokeTimeoutMs` | `120000` | 单次 invoke 默认预算 |
| `routeTimeoutMs` | `900000` | Freerouting 预算 |
| `reportRepo` | `samuelwhg/dsh-lceda` | `lceda_report submit` 上报到的 GitHub `owner/name`；留空即关闭上报 |
| `allowGuiConcurrent` | `false` | 允许 GUI 会话存在时写操作（危险） |

文档 id 就是 `eda.dmt_EditorControl.openDocument` 要的 id，无头 CLI 无法凭空生成——但
`.eprj3` 是纯 JSON，不用开 GUI 也能读：文件里 `profile.pcbs` / `profile.sheets` 的键名就是
这两个 id（有多块板 / 多页时取第一个）。配置非法会在加载时报出字段路径，例如
`$.invokeTimeoutMs expected number but got nope`。

### 配置放在哪

| 内容 | 项目级 | 全局（profile） |
| --- | --- | --- |
| 用哪个工程 | 会话在哪个目录跑：那里唯一的 `.eprj3` | bundle 行上的 `projectPath` |
| `lceda-dev` 技能 | `<工程>/.dsh/skills/lceda-dev/SKILL.md`（或 `.agents/skills/…`）优先，盖过随包那份 | 装在包里，安装时注册进内存 |
| 九个工具 | — | profile |
| MCP server | 不用：插件直接调 `lceda-pro` 自己的 CLI，不写 `.dsh/mcp.json` | — |

DSH 没有「项目级插件配置」这种文件：工程靠「会话在哪里跑」选定，其余都在上面那条 profile 行里。
也没有随包发预设：装好 bundle 就把工具和技能注册到整个 profile，任何 agent 都能直接用。

## 5 分钟首次跑通

1. 在工程文件夹里开会话即可——工作区里只有一个 `.eprj3` 就不用配；有多个再按上面设 `projectPath`（`exePath` 留空即可，除非 LCEDA 装在非常规位置——找不到 exe 时 `lceda_session list` 会把搜过的路径全列出来）。
2. `lceda_session` `{ "action": "list" }` —— 确认 CLI 握手，此时还没开会话。
3. `lceda_session` `{ "action": "open" }` —— 无头打开工程，返回 `sessionId`。
4. `lceda_run` `{ "code": "return Object.keys(eda).filter(k => k.startsWith('pcb_'))" }` —— 看你装的编辑器版本的 PCB API 面。
5. `lceda_run` `{ "doc": "pcb", "code": "<真正要做的>" }` —— 之后按 skill 的工作流走。

若第 4 步返回空列表：编辑器版本与预期不同，先 `lceda_session` `{ "action": "clean" }`
再试（僵尸会话会让 `getAll` 返回 `null`）。

## 工具

| 工具 | 作用 |
| --- | --- |
| `lceda_session` | 无头会话 `open` / `list` / `close` / `clean`；从不碰用户 GUI 会话 |
| `lceda_run` | 跑编辑器 JavaScript（`doc=pcb\|sch` 先打开并等待文档就绪） |
| `lceda_export` | 导出 Gerber / BOM / 坐标 / 装配图（UTF-16LE CSV 已解码） |
| `lceda_route` | `clearRouting`（`keepExisting` 时跳过）→ DSN → Freerouting → 导入 SES → 保存；导入 0 轨直接报错，不算成功 |
| `lceda_check` | `drc`、与期望 JSON 比对焊盘网表、焊盘/走线/过孔连通性（`full: true` 返回全量） |
| `lceda_pour` | 重建铺铜或设置连接方式 |
| `lceda_sch_wire` | 在精确引脚热点上画原理图导线 |
| `lceda_sch_netlist` | 编译原理图网表 |
| `lceda_report` | `list` 看已记录故障、`submit` 用你自己的 `gh` 上报、`solve` 记下解决办法 |

长列表只回「条数 + 前几行」，全量落在 `<workDir>/reports/`；前几行不够时加
`full: true`。每次写完都要读回核对：导入没有落地任何走线是错误，不是部分成功。

出厂 `lceda-dev` skill 带工作流顺序与红线（GUI 占用工程时不做写操作、勿整文件覆盖
`PCB1.epcb2`、内层有信号时不铺实心铜、`importChanges` 后必核对全部焊盘网表、
符号/泪滴/对话框交回 GUI）。

## API 面与能力范围

LCEDA Pro 没有完整公开插件 SDK，本插件是通过 JavaScript 驱动编辑器内的 `eda` 对象，
只保证下列 API 家族可用——已在 **LCEDA Pro 4.1.99.7adca3d2** 上逐个核对存在。编辑器自带
权威查询，比这张表更准：`lceda-pro doc api` 列类、`lceda-pro doc api --class-name PCB_Drc`
列某类方法、`lceda-pro --search <词>` 模糊找命令，见
<https://prodocs.lceda.cn/storage/texts/api/guide/cli-for-ai.md>。本表只列插件实际用到的：

| 家族 | 用到的调用 |
| --- | --- |
| 编辑器 / 文档 | `dmt_EditorControl.openDocument`、`waitForDocumentReady`；`pcb_Document.save` / `clearRouting` / `importAutoRouteSesFile`；`sch_Document.save` |
| 图元 | `pcb_PrimitiveComponent.getAll` / `getAllPinsByPrimitiveId`、`pcb_PrimitiveLine.getAll`、`pcb_PrimitiveVia.getAll`、`pcb_PrimitivePour.getAll`、`sch_PrimitiveWire.create` |
| 检查 | `pcb_Drc.check` / `getDrcResult` / `getCurrentRuleConfiguration` / `overwriteCurrentRuleConfiguration` |
| 网表 / 制造 / 文件 | `sch_Netlist.getNetlist`、`pcb_ManufactureData.getDsnFile` 及导出入口、`sys_FileSystem.readFileFromFileSystem` |

其余都不在范围内：符号创建、改封装引用、泪滴和部分对话框只能在 GUI 做，工具会返回
handoff 而不是假装成功。`lceda_run` 能执行任意编辑器 JS，所以表外的调用在你的构建上
也许能跑，但没有任何保证——先探测
（`lceda_run {"doc":"pcb","code":"Object.keys(eda)"}`），方法不存在就当不可用。
LCEDA Pro 升级可能改名或移除这些调用；工具开始报 `... is not a function` 就是这个信号。

## 权限

声明能力：`tools:register`、`fs:read`、`fs:write`、`subprocess`。

- 读工程文件；写 `workDir` 下的产物（DSN、SES、导出的 CSV 与生产文件）以及
  `sesDirWin` 下的 `.ses` 副本。
- 启动 LCEDA 专业版 exe；`lceda_route` 还会起 `java -jar freerouting.jar`。二者都用
  argv 数组（不经 shell）启动，带超时，超时即杀。
- 会改设计：`lceda_run`、`lceda_route`、`lceda_pour`、`lceda_sch_wire` 都会保存文档。
  工程请放版本管理。
- 无网络收发、不读凭据、不改 prompt：`dsh.labels` 故意为空。`lceda_report submit`
  调的是**你自己**已登录的 `gh`，插件从不持有 GitHub token。
- 收回权限：卸载插件，或在 profile 里禁用该行。

## 问题上报

顺序是「先借鉴，再把问题+解法一起反哺」，且不会自己外发任何东西。

1. **自动记录。** 每个 `lceda_*` 工具都套了故障记录器。失败原因不属于配置问题（自带
   修法的报错，例如缺 `projectPath`，不会被记成噪音）时，会在 `<workDir>/issues/<id>.json`
   落一条记录，工具报错里同时给出这个 id。落盘前先脱敏：家目录变 `~`、绝对路径变
   `<path>`、`ghp_*` / `github_pat_*` 变 `<token>`；入参同样截断并脱敏。
2. **先查再调。** `lceda_report { "action": "search", "id": ... }` 两边都查：本地记录
   （连同别人已记下的解法）和上游 Issues（`gh issue list --search <工具名+报错关键词>`）。
   查到带解法的就用它，别重复踩。
3. **再解决。** `{ "action": "solve", "id": ..., "note": "原因 + 怎么修好的" }` 把解法
   存回这条记录。
4. **最后只反哺一次。** `{ "action": "submit", "id": ... }` 先在上游搜同类：命中就把你的
   解法作为评论贴到那个 issue（不重复开），没命中才新建一条，正文同时带报错、调用、
   环境**和**有效解法。两种情况记录里都会留下 issue URL。

没装 `gh` 也不会坏——安装提示第 2 步就是为这个准备的：Windows 用
`winget install --id GitHub.cli`，WSL/Linux 用 `sudo apt install gh`（或把 release tarball
放进 `~/.local/bin`），macOS 用 `brew install gh`，然后执行一次 `gh auth login`；插件在缺
`gh` 时给出的提示也会带上当前平台该跑的那条命令。除此之外：`search` 返回浏览器搜索链接，`submit` 返回预填好的
`github.com/.../issues/new?title=…` 链接——不用 token，插件自己不发任何网络请求。装了
`gh` 就走你已登录的身份，插件从不持有凭据。

`reportRepo`（默认 `samuelwhg/dsh-lceda`，留空即关闭上游那半）决定第 2、4 步去哪里查。

给 agent 的习惯：遇到故障先 `search`；确定解法、或同一故障出现两次，就提议 `submit`。

## 升级、回滚、卸载

```sh
dsh plugin --profile <profile> add git+https://github.com/samuelwhg/dsh-lceda.git   # 升级
dsh plugin --profile <profile> add git+https://github.com/samuelwhg/dsh-lceda.git#<tag-或-commit>  # 锁定 / 回滚
dsh plugin --profile <profile> remove dsh-lceda                                  # 卸载
```

卸载不会删你的产物：`workDir`（默认 `.dsh-lceda`）与 `sesDirWin` 下的副本仍在，自行清理。
先关会话（`lceda_session` `{ "action": "clean" }`）；重新加载插件也会关掉它自己开的会话。

## 排错

| 现象 | 下一步 |
| --- | --- |
| `LCEDA Pro not found: install it, or set config exePath ...` | 装 LCEDA 专业版，或把 `exePath` 指到 `lceda-pro.exe`（WSL `/mnt/d/…`，Windows `D:\…`）；报错里会列出探测过的每个盘根 |
| `cannot start "<exePath>" ... ENOENT` | 配置的路径不存在——改 `exePath`，或清空它回退自动探测 |
| `no project path` / `found N .eprj3 files` | 传 `.eprj3` 路径；工作区里有多个时设 `projectPath` |
| `config pcbUuid is not set` / `schUuid` | 为对应板/页设置文档 id（见「配置」） |
| `user GUI session open (...)` | 关 GUI，或明知 `.eprj3` 同步会覆盖再设 `allowGuiConcurrent: true` |
| 工具报 `... is not a function` | 你的 LCEDA Pro 版本改名或移除了该调用：先用 `lceda_run {"code":"Object.keys(eda)"}` 探测，见「API 面与能力范围」 |
| `getAll` 返回 `null` 或会话直接挂 | `lceda_session` `{ "action": "clean" }` 后重试；无头 canvas 订阅很脆 |
| DRC 把会话搞崩 | `lceda_check` 会回退到 `getDrcResult`；要权威报告在 GUI 里跑 `drc` |
| `lceda_route` 报 jar/java 缺失 | 设 `freeroutingJar`、`javaBin`，同一 shell 里 `java -version` 要能跑 |
| Freerouting 跑完仍有未布通网 | 调大 `routeTimeoutMs` / `passes`，或先手工布；Freerouting 不保留手画总线 |
| `board.ses` 没导入 | `sesDirWin` 必须是 Windows 编辑器能读到的路径（`D:\...` 或 `/mnt/d/...`，不能只在 WSL 里） |
| 写操作被拒 | 有 GUI 会话占着工程——这是护栏，不是 bug |

## 开发

```sh
pnpm install
pnpm build        # tsdown → lib/（已入库，安装时免构建）
pnpm test         # vitest
npx tsc --noEmit
npm_config_cache="$PWD/.npm-cache" npx -y dsh-standards@1.6.12 check . --scope entry --entry-claim static --no-exec --host-version 0.2.2-rc.3
```

## 能力声明说明（DSC-11.5）

`fs:read`、`fs:write`、`subprocess` 是真在用才声明，但走的是 `node:fs` /
`node:child_process` 直连（导出解码到 WSL 目录、启动 Windows LCEDA CLI 与 Freerouting
JVM），不是静态扫描认的 `ctx.fs` / `ctx.subprocess` 缝。缝可见的触发点是 `tools:register`
与 skill 注册。声明保留：它是准确的，DSH 的权限预检也依赖它。
