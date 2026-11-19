# Frontend Development Guidelines

> Best practices for frontend development in this project.

---

## Overview

This directory contains guidelines for frontend development in this project (React 19 + Tauri).

迁移分支的原生桌面另见 [nsh 桌面规范](../desktop/index.md)；本目录继续适用于 React/WebUI 与现有 Tauri 前端。

---

## Guidelines Index

| Guide                                             | Description                             | Status |
| ------------------------------------------------- | --------------------------------------- | ------ |
| [Directory Structure](./directory-structure.md)   | Module organization and file layout     | Filled |
| [Component Guidelines](./component-guidelines.md) | Component patterns, props, composition  | Filled |
| [Hook Guidelines](./hook-guidelines.md)           | Custom hooks, data fetching patterns    | Filled |
| [Project Model Scope](../backend/project-model-scope.md) | Shared picker, draft editor, preference synchronization | Filled |
| [Next Prompt & Built-in Extensions](../backend/next-prompt-and-extensions.md) | Shared prediction lifecycle, settings, Ghost Text and adoption | Filled |
| [Prompt Cache Keep-alive](../backend/cache-keep-alive.md) | Model policy, bounded background requests, shared quiet notices | Filled |
| [Desktop Startup & Tray](../backend/desktop-lifecycle.md) | Desktop-only startup preferences and localized native menu | Filled |
| [State Management](./state-management.md)         | Local state, global state, server state | Filled |
| [Quality Guidelines](./quality-guidelines.md)     | Linting, testing, forbidden patterns    | Filled |
| [File Links & Workspace Tabs](./html-report-links.md) | Project tabs, safe Markdown/code previews, Local/WSL/SSH system opening and WebUI guard | Filled |
| [Desktop Git Workspace](./git-workspace.md) | Native-only read-only Git tab, workspace lifecycle and sidebar removal | Filled |
| [Type Safety](./type-safety.md)                   | Type patterns, validation               | Filled |

---

## How to Fill These Guidelines

For each guideline file:

1. Document your project's **actual conventions** (not ideals)
2. Include **code examples** from your codebase
3. List **forbidden patterns** and why
4. Add **common mistakes** your team has made

The goal is to help AI assistants and new team members understand how YOUR project works.

---

**Language**: All documentation should be written in **English**.
