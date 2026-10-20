# Frontend Development Guidelines

> Best practices for frontend development in this project.

---

## Overview

This directory contains guidelines for frontend development in this project (React 19 + Tauri).

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
