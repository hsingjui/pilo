# 研究：原生 Windows 上 `cargo test -p pilo --lib` 以 0xc0000139 退出

## 现象

测试二进制能编译，启动即 `STATUS_ENTRYPOINT_NOT_FOUND`（0xc0000139），一个用例都不执行。`cargo check -p pilo --all-targets` 正常。

## 已确认

- `src-tauri/build.rs` 末尾调用默认的 `tauri_build::build()`，没有自定义 Windows 清单。
- `pilo` lib 依赖 `tauri 2.12`；仓库中没有独立的 `.manifest` 文件。

## 假设（待实现阶段验证）

Tauri 2 在 Windows 上依赖 Common Controls v6（如 `TaskDialogIndirect`）。`tauri_build::build()` 只给 bin 目标嵌入含 comctl32 v6 依赖的应用清单；lib 的单元测试二进制没有清单，加载时解析到 v5 的 `comctl32.dll`，找不到入口点而退出。

## 候选修法

1. `build.rs` 改为 `tauri_build::try_build(Attributes::new().windows_attributes(WindowsAttributes::new_without_app_manifest()))`，
   再用 `cargo:rustc-link-arg=/MANIFEST:EMBED` 和 `/MANIFESTINPUT:<manifest>` 给所有目标（含测试）嵌入同一份清单。
   清单内容须与 tauri-build 默认清单一致（comctl32 v6 依赖等），避免改变正式应用行为。
2. 仅对测试目标追加清单链接参数（需确认 `rustc-link-arg-tests` 是否覆盖 lib 单元测试目标）。

## 验收

- 先用最小改动在原生 Windows 复现并确认根因（例如检查测试二进制导入表 / 清单）。
- 修复后 `cargo test -p pilo --lib` 能在原生 Windows 运行；`pnpm tauri dev` 启动的应用清单与修复前一致（对比嵌入清单）。
- 如果根因不是清单，回到规划阶段重新评估，不扩大改动范围。
