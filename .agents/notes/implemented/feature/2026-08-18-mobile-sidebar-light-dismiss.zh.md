# Agent Note: 移动端侧边栏轻触关闭

Status: implemented

[English](2026-08-18-mobile-sidebar-light-dismiss.md) | 中文

部分被 [移动端覆盖式抽屉](2026-08-18-mobile-overlay-drawer.md) 取代：背景层现在会调暗覆盖式抽屉后的整个画面；本文所述的关闭机制不变。

## 问题

在窄视口（低于 SIDEBAR_AUTO_COLLAPSE 断点）下，侧边栏会自动折叠为控制栏，控制栏开关可将其重新展开为覆盖在收窄主区域之上的宽抽屉。除了点击该栏最远端的控制栏开关或跨过断点，没有其他方式能收回抽屉：选择会话后，抽屉会一直占据屏幕大部分区域，且没有轻触关闭的能力。移动端抽屉的标准契约——点击面板外部（或按 Escape）即可将其折叠——缺失了。

## 决策

AppFrame 负责窄屏展开状态的轻触关闭表面。当视口为窄屏且侧边栏展开时，它渲染一层覆盖侧边栏右侧区域的透明背景（`.scrim`，绝对定位在 `left: cols.sidebar`，位于 shell overlay 层 z-index 20 之下），并安装一个监听 Escape 的 window `keydown` 事件；二者都通过布局 store 新增的 `closeSidebar` action 折叠侧边栏。`closeSidebar` 与 `closeDetails` 对称：在窄屏下清除 `narrowExpanded` 重展开覆盖标志，使宽度偏好得以在窗口重新变宽时保留；在宽屏下写入 `sidebar = 0`。宽屏桌面布局不受影响——不加背景、不加快捷键。

## 备选方案

**复用 `toggleSidebar` 完成关闭。** 已否决：因为背景只会在抽屉展开时渲染，但一个专用的 action 能让操作更加明确，在已关闭时是无操作（no-op），并能补全现有的 open／`closeDetails` 对称关系。

**像模态抽屉一样调暗背景。** 已否决：因为展开的侧边栏是挤占而非覆盖主区域，调暗只会隐藏内容而不会带来视觉提示；需求是行为层面（点击外部即折叠），因此背景保持透明。

## 影响

在移动端，展开的侧边栏可通过点击其右侧区域或按 Escape 折叠，且宽度偏好会在窗口重新变宽时保留。Escape 仅作用于窄屏展开状态，桌面键盘行为保持不变。app-frame 与 layout-store 客户端 spec 覆盖了背景点击、Escape、宽视口下无背景，以及已关闭时的 no-op action。
