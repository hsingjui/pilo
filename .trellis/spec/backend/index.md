# Backend Development Guidelines

> Best practices for backend development in this project.

---

## Overview

This directory contains guidelines for backend development in this project (Tauri desktop app + `pilo-protocol` / `pilo-server` crates).

---

## Guidelines Index

| Guide                                           | Description                                       | Status |
| ----------------------------------------------- | ------------------------------------------------- | ------ |
| [Directory Structure](./directory-structure.md) | Module organization and file layout               | Filled |
| [Database Guidelines](./database-guidelines.md) | SQLite schema, queries, migrations                | Filled |
| [Project Model Scope](./project-model-scope.md) | Project preferences, transport/events, effective Scope | Filled |
| [Next Prompt & Built-in Extensions](./next-prompt-and-extensions.md) | Connection prediction, shared input assistance, fixed Server deployment | Filled |
| [Prompt Cache Keep-alive](./cache-keep-alive.md) | Model policy, bounded background requests, shared quiet notices | Filled |
| [File Links & Workspace Tabs](../frontend/html-report-links.md) | Connection-aware bounded text previews and validated system file opening | Filled |
| [Desktop Git Workspace](../frontend/git-workspace.md) | Existing Tauri Git reads, connection routing and literal project-relative paths | Filled |
| [Error Handling](./error-handling.md)           | `Result<T, String>` boundary, error text contract | Filled |
| [Quality Guidelines](./quality-guidelines.md)   | Code standards, forbidden patterns                | Filled |
| [Logging Guidelines](./logging-guidelines.md)   | `eprintln!` diagnostics, log levels               | Filled |
| [Remote WebUI & Event Hub](./remote-webui.md)   | Remote HTTP/WS adapter, auth, event replay        | Filled |
| [Desktop Startup & Tray](./desktop-lifecycle.md) | Login startup, native tray, Dock/taskbar visibility, exit | Filled |
| [Runtime Resource Lifecycle](./runtime-lifecycle.md) | Idle Pi retention, byte-bounded queues, graceful server cleanup | Filled |
| [Session History Cache](./history-cache.md) | Fingerprinted memory/disk windows, load deduplication, lazy images | Filled |

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
