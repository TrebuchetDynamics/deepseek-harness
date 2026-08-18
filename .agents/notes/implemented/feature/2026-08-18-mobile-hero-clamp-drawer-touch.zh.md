# Agent Note: 移动端英雄区钳制与抽屉触控目标

Status: implemented

[English](2026-08-18-mobile-hero-clamp-drawer-touch.md) | 中文

## 问题

对每个移动端视口（375、390、412、344px 宽）的 Playwright 几何审计发现，两处之前移动端改动未覆盖的持续缺陷。(1) AgentPresetSeat 预设芯片保持 28px 高，且由于英雄区的"工作区触发器 + 预设"一行（`[workspace 183px][preset 164px]`）比 311px 的输入框卡片更宽，其右缘在视口处被裁剪（在 375px 屏幕上测得右缘为 427）——芯片字面上一半被截断。(2) 侧边栏覆盖抽屉复用展开布局，其控件仍停留在 28px 桌面尺寸；将侧边栏控件放大到 44px 的移动端规则只作用于 `.collapsed` 控制栏状态，因此抽屉的折叠（28px）与新会话（38px）控件从未达到触控下限。接入流程中的供应商/API 密钥输入框也仍为 32px。

来自早期全页检测器的文件夹浏览器重叠信号被证实为误报：对话框的滚动列在其不透明页脚上方裁剪（在 375px 运行中，列底 439 < 页脚顶 455），因此无需修复。

## 决策

在布局层用于侧边栏自动折叠的同一窄屏断点（`max-width: 1023px`）下采用纯 CSS 移动端规则：

- HeroShell：此处无改动；该行位于 ConversationRoot——`.heroWorkspaceRow` 启用换行（`flex-wrap: wrap; row-gap: 8px`），使预设芯片落入自己的一行，而不再超出输入框卡片右缘被裁剪。
- AgentPresetSeat：`.seat` 获得 `min-height: 40px`，与其共用一行的触发器（英雄区其余部分所用的 40px 触控下限）一致。
- SidebarRoot：抽屉（非 `.collapsed`）的 `.iconButton` 放大到 40x40，`.newSession` 达到 `min-height: 40px`；控制栏的 44px 规则不变。
- ModelsSection：供应商/API 密钥 `.input` 获得 `min-height: 40px`。

桌面端几何不变：所有规则都在媒体查询内，基础声明未改动。

## 备选方案

**收缩预设芯片以适配（flex: 1 + 省略号）。** 已否决：截断预设名称会损害新会话界面的可发现性；换行到第二行能在每个窄宽度下保留完整标签。

**将抽屉控件放大到 44 以匹配控制栏。** 已否决：控制栏的 44px 来自在 56px 控制栏内收紧其固定侧内边距（44 + 2*6 = 56）；无约束的抽屉无需如此，匹配输入框与英雄区所用的 40px 下限即可。

**同时放大抽屉的会话工具栏（搜索 / 视图选项 / 添加工作区）。** 测试中否决：该 28px 工具栏位于契约冻结的紧凑容器内（`.searchSlot` max-width 28px、`.headerActions` max-width 60px、`.sectionHeader` 高度 36px）；将圆形按钮放大到 40px 会把搜索按钮推入"视图选项"8px 并裁剪"添加工作区"，因此这些次级工具图标保留 S1 基线。

## 影响

在窄视口下，预设芯片永不裁剪且两个英雄区芯片均为 40px 高；抽屉主控件（折叠、新会话）达到 40px 下限，供应商输入框放大到 40px；桌面端不变。样式契约 spec 固定了每条规则（新增 ui-agent-preset seat-style spec；扩展 ui-sidebar sidebar-styles、ui-conversation mobile-touch-targets 与 ui-settings-models styles spec）。重建加 Playwright 复测确认预设芯片为 40px 且其右缘位于 375px 视口内，抽屉主控件为 40px，全部四个移动端视口均无裁剪或重叠控件。
