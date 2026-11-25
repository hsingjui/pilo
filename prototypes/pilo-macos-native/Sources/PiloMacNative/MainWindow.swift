import SwiftUI

struct MainWindowView: View {
    @EnvironmentObject private var store: PrototypeStore
    @State private var columnVisibility = NavigationSplitViewVisibility.all
    @State private var showInspector = false
    @State private var showCommandPalette = false

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            SidebarView(showCommandPalette: $showCommandPalette)
                .navigationSplitViewColumnWidth(min: 230, ideal: 272, max: 340)
        } detail: {
            ChatDetailView()
        }
        .navigationTitle(store.selectedSession?.title ?? "Pilo")
        .toolbar {
            ToolbarItem(placement: .navigation) {
                Image(systemName: "bubble.left.and.bubble.right")
                    .foregroundStyle(.secondary)
            }

            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    showInspector = true
                } label: {
                    Image(systemName: "terminal")
                }
                .help("打开终端预览")

                Menu {
                    Button("Xcode") {}
                    Button("VS Code") {}
                    Button("Finder 中显示") {}
                } label: {
                    Image(systemName: "arrow.up.forward.square")
                }
                .help("在外部编辑器打开")

                Button {
                    withAnimation(.snappy) { showInspector.toggle() }
                } label: {
                    Image(systemName: "arrow.triangle.branch")
                }
                .help("Git 分支 / Diff 面板")

                Menu {
                    Button("复制会话链接") {}
                    Button("导出 Markdown") {}
                    Divider()
                    Button("归档会话") {}
                } label: {
                    Image(systemName: "ellipsis")
                }
                .help("更多操作")
            }
        }
        .inspector(isPresented: $showInspector) {
            InspectorView()
                .inspectorColumnWidth(min: 280, ideal: 360, max: 480)
        }
        .overlay {
            if showCommandPalette {
                CommandPaletteView(isPresented: $showCommandPalette)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .showCommandPalette)) { _ in
            showCommandPalette = true
        }
    }
}

struct SidebarView: View {
    @EnvironmentObject private var store: PrototypeStore
    @Environment(\.openSettings) private var openSettings
    @Binding var showCommandPalette: Bool
    @State private var searchText = ""
    @State private var expandedProjects: Set<UUID> = []

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("搜索会话", text: $searchText)
                    .textFieldStyle(.plain)
                Button {
                    showCommandPalette = true
                } label: {
                    Image(systemName: "command")
                }
                .buttonStyle(.borderless)
                .help("命令面板 ⌘K")

                Button {
                    store.createSession()
                } label: {
                    Image(systemName: "square.and.pencil")
                }
                .buttonStyle(.borderless)
                .help("新建会话")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(.bar)

            List {
                ForEach(filteredConnections) { connection in
                    Section {
                        ForEach(connection.projects) { project in
                            ProjectHeaderRow(project: project, connectionKind: connection.kind)

                            let sessions = visibleSessions(for: project)
                            ForEach(sessions) { session in
                                SidebarSessionRow(
                                    session: session,
                                    selected: store.selectedSessionID == session.id
                                ) {
                                    store.select(sessionID: session.id)
                                }
                            }

                            if project.sessions.count > sessions.count {
                                Button(isExpanded(project) ? "收起" : "查看全部") {
                                    toggleProject(project.id)
                                }
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .buttonStyle(.plain)
                                .padding(.leading, 32)
                            }
                        }
                    } header: {
                        HStack(spacing: 7) {
                            Image(systemName: connection.kind == .ssh ? "network" : "laptopcomputer")
                            Text(connection.name)
                            Spacer()
                            Circle()
                                .fill(.green)
                                .frame(width: 6, height: 6)
                        }
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.secondary)
                        .textCase(nil)
                    }
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.visible)

            Divider()
            HStack(spacing: 13) {
                Button {
                    openSettings()
                } label: {
                    Image(systemName: "gearshape")
                }
                .buttonStyle(.borderless)
                .help("设置 ⌘,")

                Spacer()

                Image(systemName: "dot.radiowaves.left.and.right")
                    .foregroundStyle(.orange)
                    .help("Remote WebUI 已开启")
                Image(systemName: "terminal")
                    .foregroundStyle(.secondary)
                    .help("本机终端环境正常")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.bar)
        }
    }

    private var filteredConnections: [MockConnection] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return store.connections }
        return store.connections.compactMap { connection in
            var copy = connection
            copy.projects = connection.projects.compactMap { project in
                let sessions = project.sessions.filter {
                    $0.title.localizedCaseInsensitiveContains(query) || project.name.localizedCaseInsensitiveContains(query)
                }
                guard !sessions.isEmpty else { return nil }
                var projectCopy = project
                projectCopy.sessions = sessions
                return projectCopy
            }
            return copy.projects.isEmpty ? nil : copy
        }
    }

    private func visibleSessions(for project: MockProject) -> [MockSession] {
        if !searchText.isEmpty || isExpanded(project) {
            return project.sessions
        }
        return Array(project.sessions.prefix(4))
    }

    private func isExpanded(_ project: MockProject) -> Bool {
        expandedProjects.contains(project.id)
    }

    private func toggleProject(_ id: UUID) {
        if expandedProjects.contains(id) {
            expandedProjects.remove(id)
        } else {
            expandedProjects.insert(id)
        }
    }
}

struct ProjectHeaderRow: View {
    let project: MockProject
    let connectionKind: MockConnection.Kind

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "folder")
                .foregroundStyle(.secondary)
            Text(project.name)
                .font(.body.weight(.medium))
                .lineLimit(1)
            Spacer()
            Text("\(project.sessions.count)")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(.leading, connectionKind == .ssh ? 2 : 0)
        .contextMenu {
            Button("新建会话") {}
            Button("在 Finder 中显示") {}
            Divider()
            Button("项目设置") {}
        }
    }
}

struct SidebarSessionRow: View {
    let session: MockSession
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: session.isRunning ? "bolt.fill" : "bubble.left")
                    .font(.caption)
                    .foregroundStyle(session.isRunning ? Color.orange : Color.secondary)
                    .frame(width: 15)
                Text(session.title)
                    .lineLimit(1)
                    .foregroundStyle(.primary)
                Spacer(minLength: 6)
                if session.hasUnread {
                    Circle()
                        .fill(.red)
                        .frame(width: 7, height: 7)
                }
                Text(session.lastActivity)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: 7)
                        .fill(Color.accentColor.opacity(0.16))
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.leading, 17)
        .contextMenu {
            Button("打开") { action() }
            Button("重命名") {}
            Button("复制会话路径") {}
            Divider()
            Button("删除", role: .destructive) {}
        }
    }
}

struct CommandPaletteView: View {
    @EnvironmentObject private var store: PrototypeStore
    @Binding var isPresented: Bool
    @State private var query = ""

    var body: some View {
        ZStack {
            Color.black.opacity(0.18)
                .ignoresSafeArea()
                .onTapGesture { isPresented = false }

            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)
                    TextField("搜索会话或输入命令", text: $query)
                        .textFieldStyle(.plain)
                        .font(.title3)
                    Text("⌘K")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(.quaternary, in: RoundedRectangle(cornerRadius: 5))
                }
                .padding(13)

                Divider()

                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(results) { session in
                            Button {
                                store.select(sessionID: session.id)
                                isPresented = false
                            } label: {
                                HStack {
                                    Image(systemName: "bubble.left")
                                        .foregroundStyle(.secondary)
                                    Text(session.title)
                                        .lineLimit(1)
                                    Spacer()
                                    Text(store.project(for: session)?.name ?? "")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 9)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(6)
                }
                .frame(maxHeight: 320)
            }
            .frame(width: 560)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
            .overlay {
                RoundedRectangle(cornerRadius: 14)
                    .strokeBorder(.quaternary)
            }
            .shadow(radius: 28, y: 14)
            .padding(.top, 90)
            .frame(maxHeight: .infinity, alignment: .top)
        }
        .background {
            Button("") { isPresented = false }
                .keyboardShortcut(.cancelAction)
                .hidden()
        }
    }

    private var results: [MockSession] {
        let sessions = store.allSessions
        guard !query.isEmpty else { return Array(sessions.prefix(9)) }
        return sessions.filter { $0.title.localizedCaseInsensitiveContains(query) }
    }
}

struct InspectorView: View {
    @State private var tab = 0

    var body: some View {
        VStack(spacing: 0) {
            Picker("面板", selection: $tab) {
                Text("Diff").tag(0)
                Text("终端").tag(1)
            }
            .pickerStyle(.segmented)
            .padding(10)

            Divider()

            if tab == 0 {
                DiffPreview()
            } else {
                TerminalPreview()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .controlBackgroundColor))
    }
}

struct DiffPreview: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Label("app/shell/Sidebar.tsx", systemImage: "doc.text")
                    .font(.headline)
                GroupBox {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("@@ -42,6 +42,11 @@")
                            .foregroundStyle(.secondary)
                        Text("  const selected = computed(() => {")
                        Text("-   return open?.sessionPath === current.sessionPath")
                            .foregroundStyle(.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.red.opacity(0.10))
                        Text("+   return sessionRowKey(current) === open?.rowKey")
                            .foregroundStyle(.green)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.green.opacity(0.10))
                        Text("  })")
                    }
                    .font(.system(.caption, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                Text("3 个文件变更 · +86 -24")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding()
        }
    }
}

struct TerminalPreview: View {
    var body: some View {
        ScrollView {
            Text("$ git diff --check\n\napp/shell/Sidebar.tsx:83: trailing whitespace\n\n$ pnpm check\n✓ oxlint passed\n✓ oxfmt passed")
                .font(.system(.callout, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
        }
        .background(Color(nsColor: .textBackgroundColor))
    }
}
