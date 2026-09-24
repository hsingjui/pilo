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
| [Error Handling](./error-handling.md)           | `Result<T, String>` boundary, error text contract | Filled |
| [Quality Guidelines](./quality-guidelines.md)   | Code standards, forbidden patterns                | Filled |
| [Logging Guidelines](./logging-guidelines.md)   | `eprintln!` diagnostics, log levels               | Filled |
| [Remote WebUI & Event Hub](./remote-webui.md)   | Remote HTTP/WS adapter, auth, event replay        | Filled |

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
