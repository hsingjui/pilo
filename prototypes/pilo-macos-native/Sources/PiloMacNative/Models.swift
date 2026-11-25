import Foundation
import SwiftUI

enum AppearanceMode: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: "跟随系统"
        case .light: "浅色"
        case .dark: "深色"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

enum AccentOption: String, CaseIterable, Identifiable {
    case system
    case orange
    case blue
    case purple
    case green

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: "系统"
        case .orange: "橙色"
        case .blue: "蓝色"
        case .purple: "紫色"
        case .green: "绿色"
        }
    }

    var color: Color? {
        switch self {
        case .system: nil
        case .orange: .orange
        case .blue: .blue
        case .purple: .purple
        case .green: .green
        }
    }
}

struct MockSession: Identifiable, Hashable {
    let id: UUID
    var title: String
    var projectID: UUID
    var isRunning = false
    var hasUnread = false
    var lastActivity: String
}

struct MockProject: Identifiable, Hashable {
    let id: UUID
    var name: String
    var path: String
    var sessions: [MockSession]
}

struct MockConnection: Identifiable, Hashable {
    enum Kind: String {
        case local = "本地"
        case ssh = "SSH"
        case wsl = "WSL"
    }

    let id: UUID
    var name: String
    var kind: Kind
    var status: String
    var projects: [MockProject]
}

struct ChatEntry: Identifiable, Hashable {
    enum Role {
        case user
        case assistant
    }

    let id: UUID
    var role: Role
    var body: String
    var isStreaming = false

    init(id: UUID = UUID(), role: Role, body: String, isStreaming: Bool = false) {
        self.id = id
        self.role = role
        self.body = body
        self.isStreaming = isStreaming
    }
}

@MainActor
final class PrototypeStore: ObservableObject {
    @Published var connections: [MockConnection]
    @Published var selectedSessionID: UUID?
    @Published private(set) var messagesBySession: [UUID: [ChatEntry]]

    @Published var appearance: AppearanceMode = .system
    @Published var accentOption: AccentOption = .system

    @Published var sendKey = "Enter"
    @Published var collapseLongText = true
    @Published var collapseProcess = true
    @Published var pluginNotifications = false
    @Published var interfaceLanguage = "简体中文"
    @Published var loginStart = "不启动"
    @Published var quitWhenWindowCloses = false
    @Published var debugTools = false

    @Published var readingFont = "系统默认"
    @Published var readingFontSize = 14.0
    @Published var monoFont = "SF Mono"
    @Published var monoFontSize = 13.0
    @Published var contextUsage = 0.076

    init() {
        let imxID = UUID()
        let piloID = UUID()
        let remotePiloID = UUID()
        let reviewID = UUID()
        let sidebarID = UUID()
        let repairID = UUID()
        let settingsID = UUID()
        let conciseID = UUID()
        let themeID = UUID()

        let piloSessions = [
            MockSession(id: sidebarID, title: "新开会话侧栏出现重复项", projectID: piloID, isRunning: true, hasUnread: true, lastActivity: "2 分钟前"),
            MockSession(id: reviewID, title: "review下未提交的修改", projectID: piloID, hasUnread: true, lastActivity: "8 分钟前"),
            MockSession(id: repairID, title: "修复 pilo-desktop 编译问题", projectID: piloID, lastActivity: "32 分钟前"),
            MockSession(id: settingsID, title: "设置中“关闭窗口”行为", projectID: piloID, lastActivity: "1 小时前"),
            MockSession(id: conciseID, title: "简略输出模式已开启", projectID: piloID, lastActivity: "昨天"),
            MockSession(id: themeID, title: "换主题后模仿系统强调色", projectID: piloID, lastActivity: "昨天")
        ]

        let imxSessions = [
            MockSession(id: UUID(), title: "无法读取会话文件", projectID: imxID, lastActivity: "12 分钟前"),
            MockSession(id: UUID(), title: "数据库连接失败排查", projectID: imxID, lastActivity: "44 分钟前"),
            MockSession(id: UUID(), title: "知识库查询优化", projectID: imxID, lastActivity: "2 小时前")
        ]

        let initialConnections = [
            MockConnection(
                id: UUID(),
                name: "本地",
                kind: .local,
                status: "已连接",
                projects: [
                    MockProject(id: imxID, name: "imx-agent", path: "~/Projects/imx-agent", sessions: imxSessions),
                    MockProject(id: piloID, name: "pilo", path: "~/Projects/pilo", sessions: piloSessions)
                ]
            ),
            MockConnection(
                id: UUID(),
                name: "SSH · devbox",
                kind: .ssh,
                status: "已连接",
                projects: [
                    MockProject(
                        id: remotePiloID,
                        name: "pilo-server",
                        path: "/srv/pilo",
                        sessions: [
                            MockSession(id: UUID(), title: "远端运行队列拥塞分析", projectID: remotePiloID, isRunning: true, lastActivity: "6 分钟前"),
                            MockSession(id: UUID(), title: "升级 Pi RPC 依赖", projectID: remotePiloID, lastActivity: "周一")
                        ]
                    )
                ]
            )
        ]

        connections = initialConnections
        selectedSessionID = reviewID
        messagesBySession = [
            reviewID: PrototypeStore.reviewConversation,
            sidebarID: PrototypeStore.genericConversation(title: "新开会话侧栏出现重复项"),
            repairID: PrototypeStore.genericConversation(title: "修复 pilo-desktop 编译问题"),
            settingsID: PrototypeStore.genericConversation(title: "设置中“关闭窗口”行为"),
            conciseID: PrototypeStore.genericConversation(title: "简略输出模式已开启"),
            themeID: PrototypeStore.genericConversation(title: "换主题后模仿系统强调色")
        ]
    }

    var selectedSession: MockSession? {
        allSessions.first { $0.id == selectedSessionID }
    }

    var allSessions: [MockSession] {
        connections.flatMap { connection in
            connection.projects.flatMap(\.sessions)
        }
    }

    func project(for session: MockSession?) -> MockProject? {
        guard let session else { return nil }
        return connections.flatMap(\.projects).first { $0.id == session.projectID }
    }

    func messages(for sessionID: UUID?) -> [ChatEntry] {
        guard let sessionID else { return [] }
        return messagesBySession[sessionID] ?? PrototypeStore.genericConversation(title: selectedSession?.title ?? "新会话")
    }

    func select(sessionID: UUID) {
        selectedSessionID = sessionID
    }

    func createSession() {
        guard let project = connections.first?.projects.last else { return }
        let session = MockSession(
            id: UUID(),
            title: "未命名会话",
            projectID: project.id,
            isRunning: false,
            hasUnread: false,
            lastActivity: "刚刚"
        )
        connections[0].projects[1].sessions.insert(session, at: 0)
        messagesBySession[session.id] = []
        selectedSessionID = session.id
    }

    func sendMessage(_ draft: String) {
        let prompt = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, let sessionID = selectedSessionID else { return }

        var transcript = messagesBySession[sessionID] ?? []
        transcript.append(ChatEntry(role: .user, body: prompt))
        let assistantID = UUID()
        transcript.append(ChatEntry(id: assistantID, role: .assistant, body: "", isStreaming: true))
        messagesBySession[sessionID] = transcript
        contextUsage = min(0.98, contextUsage + 0.012)

        Task { @MainActor [weak self] in
            guard let self else { return }
            try? await Task.sleep(for: .milliseconds(450))
            let chunks = [
                "收到。我会先核对当前工作区的改动范围，",
                "再检查受影响调用链。\n\n",
                "已定位到侧栏选中态与未读标识的状态合并逻辑，",
                "接下来会给出最小修复建议。"
            ]
            for chunk in chunks {
                self.append(chunk, to: assistantID, in: sessionID)
                try? await Task.sleep(for: .milliseconds(220))
            }
            self.finishStreaming(assistantID, in: sessionID)
        }
    }

    private func append(_ chunk: String, to assistantID: UUID, in sessionID: UUID) {
        var transcript = messagesBySession[sessionID] ?? []
        guard let index = transcript.firstIndex(where: { $0.id == assistantID }) else { return }
        transcript[index].body += chunk
        messagesBySession[sessionID] = transcript
    }

    private func finishStreaming(_ assistantID: UUID, in sessionID: UUID) {
        var transcript = messagesBySession[sessionID] ?? []
        guard let index = transcript.firstIndex(where: { $0.id == assistantID }) else { return }
        transcript[index].isStreaming = false
        messagesBySession[sessionID] = transcript
    }

    private static let reviewConversation: [ChatEntry] = [
        ChatEntry(role: .user, body: "review下未提交的修改"),
        ChatEntry(
            role: .assistant,
            body: "我会静态审查暂存、未暂存和未跟踪的改动，重点看回归风险及其调用链。不会修改文件，也不运行测试或构建。\n\n初步看，主要风险集中在会话选中态、项目展开状态与未读标识三处共享派生状态。建议优先核对 `sidebar-projects` 中 recency 排序与 row key 的一致性。"
        )
    ]

    private static func genericConversation(title: String) -> [ChatEntry] {
        [
            ChatEntry(role: .user, body: title),
            ChatEntry(role: .assistant, body: "这是一条用于原型演示的会话记录。切换左侧会话后，标题、上下文与 Composer 草稿状态会同步变化。")
        ]
    }
}
