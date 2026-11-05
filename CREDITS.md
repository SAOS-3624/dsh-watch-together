# CREDITS.md

> 许可证与"这个项目不做什么"的声明在 [NOTICE](NOTICE)。本文件只记**谁做了这件事**。

本仓库的绝大多数改动不是设计出来的，是被用出来的：有人在真实场景里跑崩了、把复现步骤写清楚、
或者干脆把补丁写好提上来。下面按"提出并推动了什么"记，**不区分代码是否被逐行采用** ——
诊断、复现和反例同样计入。

## 1. 作者

[@SAOS-3624](https://github.com/SAOS-3624) —— 项目发起与维护。

## 2. 代码与设计贡献

| 贡献者 | 内容 |
|---|---|
| [@ggfgfgf-on](https://github.com/ggfgfgf-on) | 合并 29 个 PR，覆盖了这个仓库大部分的非核心链路：**设置页**（#11 原生设置进插件页、#32 改成自动保存、#55 撤出全局设置 tab）、**悬浮窗**（#22 解耦与样式、#27/#28/#29 折叠/标题栏/小框模糊/色散/内框对齐、#42 气泡形状变化后重合成、#47 `capturable` 缓存、#51 远程与录屏下的纯色底板、#54 默认帧率降到 60 并按绘制耗时让位）、**语音**（#1 attach 失败回滚订阅、#31 卸载时 detach、#36 预合成 scheduled 台词缩首声延迟）、**聊天服务**（#3 兜底定时器、#35 跨域与游标重置）、**台词边界**（#5 `lead` 校验、#6 不消费未来台词、#7 只报真正缺的段、#8 512 段上限、#38 `at:null` 当成没写）、**交付门槛**（#17 唤醒失败节流、#19 无音轨视频能收尾）、**窗口协议**（#25 hide/show 的 boolean 返回值、#26 snapshot 不再重开 WDA、#40 GPU 越界跳过） |
| [@gao804](https://github.com/gao804) | #52 输入框光标跟着插入点走、按 530ms 闪烁；#53 被截断的长消息点一下展开、独占整个消息区 |
| [@DreamDLYY](https://github.com/DreamDLYY) | #23 拖动窗口时钳位 —— 越界后 `mss` 每帧抛 `Region has zero or negative size`、背景永久花屏 |

## 3. 问题报告与诊断

| 报告者 | 内容 | 落地 |
|---|---|---|
| [@CauchyCCC](https://github.com/CauchyCCC) | [issue #50](https://github.com/SAOS-3624/dsh-watch-together/issues/50) 远程控制 / 录屏 / 截图下悬浮窗**完全看不见**（连文字都没有），但进程活着、还挡鼠标 | 定位到 `WDA_EXCLUDEFROMCAPTURE`：命中远程环境时改用纯色底板（#51） |
| [@erjiatie](https://github.com/erjiatie) | [issue #44](https://github.com/SAOS-3624/dsh-watch-together/issues/44) 0.2.7 使用中的三个问题 | 其中两条分别落成 #47（不再每 4ms 读配置）与 #40（越界守卫） |
| [@TowardsDawn](https://github.com/TowardsDawn) | [issue #21](https://github.com/SAOS-3624/dsh-watch-together/issues/21) 安装方式不够规范（同一建议也提给了 storyboard 与 see-now） | 已记入 README 的安装段 |
| [@jediliu005](https://github.com/jediliu005) | [issue #56](https://github.com/SAOS-3624/dsh-watch-together/issues/56) 安全审计：屏幕内容进上下文、毛玻璃可读性、缺暂停入口 | 工具契约加了"屏幕是不可信输入"的常驻说明；`glass:"solid"` 是现成开关；暂停按钮仍在待办 |

## 4. 运行时依赖

不随本仓库分发、只在运行时被调用的外部组件，见 [NOTICE](NOTICE) 的 "Third-party components" 一节。

## 5. 如果将来真的要复制代码

本仓库不含任何第三方源代码。若将来某个实现参考了别处的代码，请在这里补一段：
来源、许可证、复制了哪几个文件、改了什么。空着就代表没有。
