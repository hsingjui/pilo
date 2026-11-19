# nsh 桌面开发规范（初稿）

> 适用 nsh-migration 原生桌面。当前平台范围与协作要求集中在[迁移协作规则](./quality-guidelines.md#迁移协作规则)。

## Guidelines Index

| Guide                                  | 内容                                 | 状态 |
| -------------------------------------- | ------------------------------------ | ---- |
| [目录与边界](./directory-structure.md) | 入口、共享代码与 Rust 桥接           | 初稿 |
| [基础组件](./component-guidelines.md)  | 导入、props、状态归属和 fixture 模式 | 初稿 |
| [主题与资源](./theme-and-assets.md)    | token、生成文件、图标、字体、i18n    | 初稿 |
| [质量与验证](./quality-guidelines.md)  | 协作规则、测试与验证命令             | 初稿 |

需求入口：[迁移 PRD](../../tasks/11-19-nsh-desktop-migration/prd.md)、[设计决策](../../tasks/11-19-nsh-desktop-migration/design.md)、[功能对齐清单](../../tasks/11-19-nsh-desktop-migration/feature-parity.md)。React/WebUI 文档见 [frontend](../frontend/index.md)，运行时文档见 [backend](../backend/index.md)。

测试流程见[质量与验证](./quality-guidelines.md)。
