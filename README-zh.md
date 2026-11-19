# dsh-lceda

[English](README.md) | 中文

DeepSeek Harness 的 **嘉立创 EDA（LCEDA 专业版）** 无头开发插件：让 agent 在真实
`.eprj3` 工程上执行编辑器 JavaScript、用 Freerouting 自动布线、核对 DRC / 焊盘网表 /
连通性、铺铜、画原理图导线、导出生产文件。

封装 LCEDA 专业版 CLI（`invoke --code-file -` 走 stdin，不落 UNC 临时文件）。
内置护栏：用户 GUI 占用工程时拒绝写操作（`.eprj3` 双向同步）、回收僵尸无头会话、
等待文档就绪、UTF-16LE CSV 导出自动解码，且绝不把 `ok:true` 当作业务成功。

## 安装

需要 DSH >= 0.2.2（Cordis 4）与 Node >= 22.19。发行包已带构建产物 `lib/`，安装时不跑构建脚本。

```sh
# 从本地检出安装
dsh plugin --profile <profile> add /path/to/dsh-lceda
# 从 git 安装（构建产物已入库）
dsh plugin --profile <profile> add git+https://github.com/samuelwhg/dsh-lceda.git
```

重启该 profile。bundle 的 `cordis.patch.yml` 会插入 `dsh-lceda` 这一行，八个 `lceda_*`
工具与 `lceda-dev` skill 自动出现，无需手改配置。

## 配置

按工程设置的值**没有默认值**：`projectPath`、`pcbUuid`、`schUuid`，自动布线还需
`freeroutingJar` / `sesDirWin`。写进安装该插件的 profile，`id` 与 bundle 插入的行一致：

```yaml
# <profile>/cordis.patch.yml
- id: dsh-lceda
  name: dsh-lceda
  config:
    projectPath: D:\work\board.eprj3                       # Windows 路径，无头打开
    pcbUuid: <PCB 文档 id>
    schUuid: <原理图页 id>
    freeroutingJar: /home/me/freerouting/freerouting.jar   # 仅 lceda_route 需要
    sesDirWin: D:\work\autoroute                           # 仅 lceda_route 需要
```

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `exePath` | *（空）* | LCEDA 专业版 CLI 的 WSL 路径。留空即自动探测：每个挂载盘下的 `/mnt/<盘>/Program Files/lceda-pro/lceda-pro.exe`，装在 C:/D:/E: 都能找到 |
| `spawnCwd` | *（空）* | 启动 Windows exe 的 cwd；留空取 `exePath` 所在盘根（盘根可避开 UNC cwd 问题） |
| `projectPath` | *（空）* | 无头打开的 Windows `.eprj3` 路径 |
| `pcbUuid` | *（空）* | `openDocument` 前奏用的 PCB 文档 id |
| `schUuid` | *（空）* | `openDocument` 前奏用的原理图页 id |
| `freeroutingJar` | *（空）* | Freerouting jar，`lceda_route` 必需 |
| `javaBin` | `java` | Freerouting 用的 Java |
| `sesDirWin` | *（空）* | 导入用的 `board.ses` 落盘目录（Windows 可见），`lceda_route` 必需 |
| `workDir` | `.dsh-lceda` | DSN/SES/导出产物的 WSL 目录，相对会话工作区 |
| `invokeTimeoutMs` | `120000` | 单次 invoke 默认预算 |
| `routeTimeoutMs` | `900000` | Freerouting 预算 |
| `allowGuiConcurrent` | `false` | 允许 GUI 会话存在时写操作（危险） |

文档 id 就是 `eda.dmt_EditorControl.openDocument` 要的 id，在编辑器里对自己的工程读一次
（无头 CLI 无法凭空生成）。配置非法会在加载时报出字段路径，例如
`$.invokeTimeoutMs expected number but got nope`。

## 5 分钟首次跑通

1. 按上面设好 `projectPath`、`pcbUuid`，重启 profile（`exePath` 留空即可，除非 LCEDA 装在非常规位置——找不到 exe 时 `lceda_session list` 会把搜过的路径全列出来）。
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
| `lceda_route` | `clearRouting` → DSN → Freerouting → 导入 SES → 保存 |
| `lceda_check` | `drc`、与期望 JSON 比对焊盘网表、焊盘/走线/过孔连通性 |
| `lceda_pour` | 重建铺铜或设置连接方式 |
| `lceda_sch_wire` | 在精确引脚热点上画原理图导线 |
| `lceda_sch_netlist` | 编译原理图网表 |

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
- 无网络收发、不读凭据、不改 prompt：`dsh.labels` 故意为空。
- 收回权限：卸载插件，或在 profile 里禁用该行。

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
| `LCEDA Pro not found: install it, or set config exePath ...` | 装 LCEDA 专业版，或把 `exePath` 指到 `lceda-pro.exe` 的 WSL 路径；报错里会列出探测过的每个 `/mnt/*/Program Files` |
| `cannot start "<exePath>" ... ENOENT` | 配置的路径不存在——改 `exePath`，或清空它回退自动探测 |
| `no project path` | 给 `lceda_session open` 传 `.eprj3` 路径，或设 `projectPath` |
| `config pcbUuid is not set` / `schUuid` | 为对应板/页设置文档 id（见「配置」） |
| `user GUI session open (...)` | 关 GUI，或明知 `.eprj3` 同步会覆盖再设 `allowGuiConcurrent: true` |
| 工具报 `... is not a function` | 你的 LCEDA Pro 版本改名或移除了该调用：先用 `lceda_run {"code":"Object.keys(eda)"}` 探测，见「API 面与能力范围」 |
| `getAll` 返回 `null` 或会话直接挂 | `lceda_session` `{ "action": "clean" }` 后重试；无头 canvas 订阅很脆 |
| DRC 把会话搞崩 | `lceda_check` 会回退到 `getDrcResult`；要权威报告在 GUI 里跑 `drc` |
| `lceda_route` 报 jar/java 缺失 | 设 `freeroutingJar`、`javaBin`，同一 shell 里 `java -version` 要能跑 |
| Freerouting 跑完仍有未布通网 | 调大 `routeTimeoutMs` / `passes`，或先手工布；Freerouting 不保留手画总线 |
| `board.ses` 没导入 | `sesDirWin` 必须是 Windows 编辑器能读到的路径（不能只在 WSL 里） |
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
