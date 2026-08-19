# Agent Note: 移动端侧边栏浮动唤起按钮

Status: implemented

[English](2026-08-18-mobile-fab-sidebar-opener.md) | 中文

部分取代 [移动端覆盖式抽屉](2026-08-18-mobile-overlay-drawer.md)：在窄屏下，关闭态现在完全隐藏（无控制栏），由浮动按钮唤起；其中描述的抽屉＋变暗背景覆盖行为保持不变。

## 问题

在窄视口下，自动折叠的侧边栏仍保留一条 56px 控制栏（SIDEBAR_COLLAPSED），在手机这样寸土寸金的屏幕上持续占用一列宽度，而且除了点按控制栏最远端的开关，没有始终可见的展开方式。移动端侧边栏应当在关闭时不占任何宽度——像 ChatGPT 那样，仅由一个浮动按钮将其唤出。

## 决策

computeColumns 新增 narrow 标志：侧边栏关闭时，窄屏解析为 0（而非 56px 控制栏），桌面端关闭态仍保留控制栏。在窄屏下，每当侧边栏关闭，AppFrame 就渲染一个顶左定位的圆形浮动按钮（.fab，基于 safe-area-inset 定位）；点击它通过布局 store 新增的 openSidebar action（仅窄屏生效：置位 narrowExpanded；宽屏为 no-op）展开抽屉，并在抽屉打开时隐藏，使变暗背景下方的画面保持整洁。隐藏的窄屏侧边栏会设置为 inert 与 `aria-hidden`；打开时焦点进入抽屉，通过背景、Escape 或侧边栏操作关闭时，焦点会回到唤起按钮。桌面端控制栏与拖动手柄保持不变。

## 备选方案

**仅通过 CSS 在窄屏把控制栏强制为 0 宽。** 已否决：控制栏宽度由让步求解器决定，CSS 覆盖会让 slot 的 width owner-prop 与主栏轨道偏离已解析的几何信息。显式的 narrow 求解器参数让几何信息保持单一来源。

**在唤起按钮上复用 toggleSidebar。** 已否决：唤起按钮必须能展开已关闭的抽屉，而不能把已展开的抽屉翻到关闭；专用 openSidebar action（closeSidebar 的镜像）幂等，并且对宽屏安全。

**始终渲染唤起按钮，让背景层盖住它。** 已否决：抽屉打开时将其卸载更简单，也不会在抽屉下方留下一个隐藏但可聚焦的控件。

## 影响

手机上侧边栏关闭时不占宽度；顶左浮动按钮以抽屉形式将其唤出，并在抽屉打开时隐藏。桌面端保留 56px 控制栏与拖动手柄。columns 求解器、layout-store、app-frame 客户端测试与移动端浏览器场景覆盖零宽折叠、inert/焦点行为、唤起按钮生命周期、抽屉几何以及 `openSidebar` 的宽屏 no-op；ui-layout README 已记录窄屏隐藏＋唤起行为。
