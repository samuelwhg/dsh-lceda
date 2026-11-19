---
name: lceda-dev
description: 嘉立创 EDA Pro（LCEDA）headless 开发流程与红线。当用户要在 LCEDA/嘉立创工程上改原理图、改 PCB、布线、铺铜、核对网表、导出生产文件（Gerber/BOM/坐标/装配图）时使用。配套工具 lceda_session/lceda_run/lceda_export/lceda_route/lceda_check/lceda_pour/lceda_sch_wire/lceda_sch_netlist。
---

# LCEDA 开发（dsh-lceda）

本页只记操作顺序与红线；工程路径与文档 uuid 由插件配置提供（projectPath/pcbUuid/schUuid，按工程设置）。

## 工具选择
- 会话：`lceda_session` open/list/close/clean。**动手前先 clean**：zombie headless 会话会让 getAll 返回 null。
- 任意编辑器操作：`lceda_run`（doc=pcb|sch 自动 openDocument+waitForDocumentReady）。代码里**自己校验业务结果并 throw**——envelope ok:true 只代表代码跑完。
- 原理图接线：`lceda_sch_wire`（导线端点必须精确等于引脚 x,y 热点）；连通性以 `lceda_sch_netlist` 编译网表为准，**pin.net 只反映网络标签**。
- 布线：`lceda_route`（clearRouting→DSN→Freerouting→SES）。**预画总线不会被 Freerouting 保留**：先布通再删指定网旧线、重画平行总线。
- 铺铜：`lceda_pour` rebuild / connectMode。**create 不填充**，必须 rebuildCopperRegion；connectMode 0=不连接 1=十字 2=实心，持久化只能单参 overwriteCurrentRuleConfiguration(c)。
- 核对：`lceda_check` drc/nets/conn。headless 的 pcb_Drc.check 可能崩会话（工具已回退 getDrcResult）；**conn 不计铺铜**，纯铺铜连接的 GND 焊盘读作孤立属预期；headless create 的线/孔网表绑定可能失效→对全部 line/via 跑 modify(id,{net:同名}) 重绑后 DRC 才准。
- 导出：`lceda_export`（CSV 自动 UTF-16LE→UTF-8）。

## API 面（只保证这些）
工具只调用已验证的 `eda.*`：`dmt_EditorControl.openDocument|waitForDocumentReady`、`pcb_Document.save|clearRouting|importAutoRouteSesFile`、`sch_Document.save`、`pcb_PrimitiveComponent/Line/Via/Pour.getAll`、`pcb_PrimitiveComponent.getAllPinsByPrimitiveId`、`sch_PrimitiveWire.create`、`pcb_Drc.check|getDrcResult|getCurrentRuleConfiguration|overwriteCurrentRuleConfiguration`、`sch_Netlist.getNetlist`、`pcb_ManufactureData.getDsnFile`、`sys_FileSystem.readFileFromFileSystem`。
表外 API 不保证存在：先 `Object.keys(eda)` 探测再用；报 `is not a function` 就是该 LCEDA 版本改了接口，handoff 或回报版本，别换名字硬猜。

## 红线
1. **用户 GUI 开着时不做写操作**（.eprj3 双向同步会互相覆盖）；工具默认拒写，除非配置 allowGuiConcurrent。
2. **勿整文件覆盖 PCB1.epcb2**：外壳/螺丝柱/安装孔等 shell 对象只存在于某些 revisions，整文件覆盖会丢改型；合并用行块 splice。
3. **importChanges（从原理图更新PCB）后必须核对全部焊盘网表**（lceda_check nets）：sch 符号脚序错会打乱 PCB 网络；非极性电容 sch/pcb 脚 1/2 相反是 cosmetic，不要为它跑 importChanges。
4. **内层不铺实心铜**当内层有信号走线（会短路）；GND 靠顶/底铺铜+回流孔，TH GND 焊盘若留隔离环需短线桥接到既有 GND 过孔。
5. headless 做不了：符号创建/改封装引用/泪滴/部分 GUI 对话框 → 返回 handoff 说明交用户 GUI，不要假成功。
6. 信号过孔旁补 GND 回流孔；铺铜前泪滴（GUI：工具→泪滴）。

## 典型顺序
clean → run/sch_wire 改设计 → sch_netlist 核对 → （GUI 同步或 importChanges 后）check nets → route → 重画总线+回流孔+重绑 → pour rebuild → check drc/conn → export → 保存并提交设计变更。
