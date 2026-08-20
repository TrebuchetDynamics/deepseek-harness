# Agent Note：upstream-merge.sh 端到端负责 fork 的上游同步

Status: implemented

[English](2026-08-20-upstream-merge-script.md) | 中文

## 问题

`upstream-merge.sh` 只有四行：校验分支、校验干净工作树、`git fetch upstream master`、`git merge --no-edit upstream/master`。合并之后的每一步都只存在于操作者的头脑中：`Dockerfile` 注释里的"随上游同步一起提升 DSH_VERSION"（镜像固定它安装的版本；忘记提升的合并会构建出比它所服务代码落后一个版本的镜像）、lockfile 变化后的 `pnpm install`（没有它，下一次类型检查或 `dsh` 启动都跑在过期依赖上），以及任何推送前校验。冲突的合并只倾倒 git 原始输出，不指明仓库的双语对冲突解决工具。脚本也无法续跑：手工解决冲突后重新运行，它只会重新 fetch 并开始一次全新的合并评估，未完成的后续步骤一概不会补上。

## 决策

脚本保持"合并前 → 合并 → 合并后"的线性管线，但变得可续跑、可自完成：

- **合并前**保留既有守卫（在 `master` 上、跟踪文件干净），并新增 `upstream` 远端存在性检查，错误信息给出确切的 `git remote add` 命令。
- **合并**统计进入的提交数，执行 `git merge --no-edit upstream/master`；冲突时以退出码 1 保留进行中的合并，打印冲突文件列表（`git diff --name-only --diff-filter=U`）与两条出路：双语文档对（其 i18n 一致性记录经仓库的合并驱动产生冲突）用 `pnpm run resolve-translation-pairing-conflicts`，取消用 `git merge --abort`。
- **可续跑**是结构性变化：`git merge-base --is-ancestor upstream/master HEAD` 检测已合并状态，此时不退出，而是继续执行合并后步骤。被冲突打断的运行在手工 `git commit` 之后重新运行即可补全——合并被跳过，后续步骤照常发生。
- **合并后**无条件且幂等地执行：把 `Dockerfile` 的 `ARG DSH_VERSION` 重新固定到 `package.json` 的版本，不同时单独提交（合并提交保持纯合并）；合并触及 `pnpm-lock.yaml` 时 `pnpm install`（以合并前捕获的 `pre_merge_head` 判定，而非 reflog 运算）；`pnpm run typecheck` 作为推送前门槛。脚本绝不推送——操作者审查后自行推送。

## 考虑过的替代方案

**在结尾自动推送，做到完全无人值守。** 否决：数百个上游提交的合并值得在验证与发布之间保留人工审查；脚本改为打印推送命令。

**在合并提交内部提升 DSH_VERSION（amend）。** 否决：合并提交是上游历史加合并本身；单独的 `chore(docker)` 提交让版本重固定独立可见、可独立回退。

**冲突时中止合并以保持干净。** 否决：冲突中的工作树就是操作者的解决现场；中止会丢弃进行中的工作，而且仓库的合并驱动已经运行过了。

**在脚本内运行更广的门禁（doc-sync、测试）。** 否决：类型检查是覆盖合并可能破坏的所有包表面的最小门禁；文档与测试门禁属于推送流程，由操作者按合并差异选择。

## 后果

一条命令完成文档记载的同步（`./upstream-merge.sh`），与 docker README 重写的章节一致；冲突的同步会列出冲突文件与配对工具，而不是 git 原始输出。首次真实运行——从 0.1.0-rc.7 到 0.1.0-rc.8 的 536 个上游提交——在五个文件上冲突（根 README 双语对及其 i18n 记录，加上 fork 移动侧栏提交触及的两个文件）；脚本以退出码 1 列出清单，双语对经 `pnpm run resolve-translation-pairing-conflicts` 解决，重跑把 `DSH_VERSION` 重固定到 `0.1.0-rc.8`、重装变化的 lockfile 并通过类型检查。

权衡：脚本信任 `package.json` 的版本作为要固定的版本（在上游同步为仓库与镜像升版的期间成立）；`pnpm install` 只在 lockfile 变化时运行，`packageManager` 字段变化而无 lockfile 变更时依赖 corepack 自身的失败；类型检查是脚本唯一的门禁——破坏文档或测试的合并由推送流程而非同步脚本捕获。
