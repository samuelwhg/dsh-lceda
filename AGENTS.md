# dsh-lceda 维护约定

本仓库只维护插件本身。用户设立的边界（2026-11-26）：**不处理其它具体项目**。

- 不读写用户自己的 `.eprj3` 工程、PCB 文件、备份目录；不为验证去开、改、还原真实工程。
- 验证手段：`vitest`（fake CLI / fake ctx 覆盖工具契约）、`tsc --noEmit`、`tsdown`、`dsh-standards`、构建产物对假数据冒烟。
- 真机验证只能由用户在**他自己指定**的工程里跑；插件侧提供 `lceda_session` / `lceda_check` 让他自己核对。
- 例外仅限用户当次明确点名某个工程。

## 发布到 npm

- 包名 `dsh-lceda`（unscoped）。已发布 `0.1.0` 为 latest；`0.0.0-stage` 是首次 token 发布留下的占位版本，别删也别当最新版。
- 发布需要**交互式 2FA**：`~/.npmrc` 里的 granular token 直接 `npm publish` 只会创建 `0.0.0-stage` 占位、不产生真实版本（npm 已禁止 token 绕过 2FA 直接发布）。
- 正确做法：用户在自己的终端 `npm login`（网页登录 + OTP）后，在该仓库执行 `npm publish`，或对已有暂存版本执行 `npm stage list` / `npm stage approve <id>`。
- 发布前固定流程：`tsdown` → `tsc --noEmit` → `vitest run` → `npm pack --dry-run` 核对 10 个文件 → 解包 grep 具体工程痕迹（无 JND/uuid/用户路径）。
