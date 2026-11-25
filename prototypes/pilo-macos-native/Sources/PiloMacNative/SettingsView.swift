import SwiftUI

enum SettingsPane: String, CaseIterable, Identifiable {
    case general
    case appearance
    case fonts
    case notifications
    case shortcuts
    case connections
    case inputSuggestions
    case draftOptimization
    case cacheKeepAlive
    case sessionNaming
    case about

    var id: String { rawValue }

    var title: String {
        switch self {
        case .general: "通用"
        case .appearance: "外观"
        case .fonts: "字体"
        case .notifications: "通知"
        case .shortcuts: "快捷键"
        case .connections: "连接"
        case .inputSuggestions: "输入建议"
        case .draftOptimization: "草稿优化"
        case .cacheKeepAlive: "缓存保活"
        case .sessionNaming: "会话命名"
        case .about: "关于"
        }
    }

    var icon: String {
        switch self {
        case .general: "gearshape"
        case .appearance: "paintpalette"
        case .fonts: "textformat"
        case .notifications: "bell"
        case .shortcuts: "keyboard"
        case .connections: "point.3.connected.trianglepath"
        case .inputSuggestions: "text.bubble"
        case .draftOptimization: "sparkles"
        case .cacheKeepAlive: "externaldrive.connected.to.line.below"
        case .sessionNaming: "character.cursor.ibeam"
        case .about: "info.circle"
        }
    }
}

struct SettingsRootView: View {
    @State private var selection: SettingsPane? = .general

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                Section("基础") {
                    SettingsSidebarRow(.general)
                    SettingsSidebarRow(.appearance)
                    SettingsSidebarRow(.fonts)
                    SettingsSidebarRow(.notifications)
                    SettingsSidebarRow(.shortcuts)
                }
                Section("项目") {
                    SettingsSidebarRow(.connections)
                    SettingsSidebarRow(.inputSuggestions)
                    SettingsSidebarRow(.draftOptimization)
                    SettingsSidebarRow(.cacheKeepAlive)
                    SettingsSidebarRow(.sessionNaming)
                }
                Section("其他") {
                    SettingsSidebarRow(.about)
                }
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 178, ideal: 200, max: 230)
        } detail: {
            Group {
                switch selection ?? .general {
                case .general: GeneralSettingsPane()
                case .appearance: AppearanceSettingsPane()
                case .fonts: FontsSettingsPane()
                case .notifications: NotificationsSettingsPane()
                case .shortcuts: ShortcutsSettingsPane()
                case .connections: ConnectionsSettingsPane()
                case .inputSuggestions: InputSuggestionsSettingsPane()
                case .draftOptimization: DraftOptimizationSettingsPane()
                case .cacheKeepAlive: CacheKeepAliveSettingsPane()
                case .sessionNaming: SessionNamingSettingsPane()
                case .about: AboutSettingsPane()
                }
            }
            .navigationTitle((selection ?? .general).title)
        }
        .frame(minWidth: 760, minHeight: 560)
    }
}

struct SettingsSidebarRow: View {
    let pane: SettingsPane

    init(_ pane: SettingsPane) {
        self.pane = pane
    }

    var body: some View {
        Label(pane.title, systemImage: pane.icon)
            .tag(pane)
    }
}

struct SettingsPaneContainer<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            Form {
                content
            }
            .formStyle(.grouped)
            .padding(18)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

struct GeneralSettingsPane: View {
    @EnvironmentObject private var store: PrototypeStore

    var body: some View {
        SettingsPaneContainer {
            Section("对话") {
                Picker("发送按键", selection: $store.sendKey) {
                    Text("Enter").tag("Enter")
                    Text("⌘ + Enter").tag("⌘ + Enter")
                }

                Toggle("长文收起", isOn: $store.collapseLongText)
                Toggle("收起过程", isOn: $store.collapseProcess)
                Toggle("插件通知", isOn: $store.pluginNotifications)

                Picker("界面语言", selection: $store.interfaceLanguage) {
                    Text("简体中文").tag("简体中文")
                    Text("English").tag("English")
                    Text("日本語").tag("日本語")
                }
            }

            Section("启动退出") {
                Picker("登录启动", selection: $store.loginStart) {
                    Text("不启动").tag("不启动")
                    Text("启动并隐藏").tag("启动并隐藏")
                    Text("启动").tag("启动")
                }
                Toggle("关闭主窗口时退出程序", isOn: $store.quitWhenWindowCloses)
            }

            Section("开发调试") {
                Toggle(isOn: $store.debugTools) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("调试工具")
                        Text("开启后，按 F12 打开调试工具。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}

struct AppearanceSettingsPane: View {
    @EnvironmentObject private var store: PrototypeStore

    var body: some View {
        SettingsPaneContainer {
            Section("主题") {
                Picker("外观", selection: $store.appearance) {
                    ForEach(AppearanceMode.allCases) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
            }

            Section("强调色") {
                HStack(spacing: 13) {
                    ForEach(AccentOption.allCases) { option in
                        Button {
                            store.accentOption = option
                        } label: {
                            ZStack {
                                Circle()
                                    .fill(option.color ?? Color.accentColor)
                                    .frame(width: 25, height: 25)
                                if store.accentOption == option {
                                    Image(systemName: "checkmark")
                                        .font(.caption.weight(.bold))
                                        .foregroundStyle(.white)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                        .help(option.title)
                    }
                    Spacer()
                    Text(store.accentOption.title)
                        .foregroundStyle(.secondary)
                }
            }

            Section("预览") {
                VStack(alignment: .leading, spacing: 10) {
                    Label("Pilo 原生工作区", systemImage: "macwindow")
                        .font(.headline)
                    Text("浅色、深色、系统强调色与控件状态会实时作用于主窗口和设置窗口。")
                        .foregroundStyle(.secondary)
                    HStack {
                        Button("主要操作") {}
                            .buttonStyle(.borderedProminent)
                        Button("次要操作") {}
                        Toggle("开关", isOn: .constant(true))
                            .toggleStyle(.switch)
                    }
                }
                .padding(.vertical, 4)
            }
        }
    }
}

struct FontsSettingsPane: View {
    @EnvironmentObject private var store: PrototypeStore

    var body: some View {
        SettingsPaneContainer {
            Section("阅读字体") {
                Picker("字体", selection: $store.readingFont) {
                    Text("系统默认").tag("系统默认")
                    Text("苹方").tag("苹方")
                    Text("New York").tag("New York")
                    Text("Inter").tag("Inter")
                }
                HStack {
                    Text("字号")
                    Spacer()
                    Slider(value: $store.readingFontSize, in: 12...18, step: 1)
                        .frame(width: 210)
                    Text("\(Int(store.readingFontSize)) pt")
                        .monospacedDigit()
                        .frame(width: 48, alignment: .trailing)
                }
            }

            Section("代码字体") {
                Picker("等宽字体", selection: $store.monoFont) {
                    Text("SF Mono").tag("SF Mono")
                    Text("JetBrains Mono").tag("JetBrains Mono")
                    Text("Menlo").tag("Menlo")
                }
                HStack {
                    Text("字号")
                    Spacer()
                    Slider(value: $store.monoFontSize, in: 11...16, step: 1)
                        .frame(width: 210)
                    Text("\(Int(store.monoFontSize)) pt")
                        .monospacedDigit()
                        .frame(width: 48, alignment: .trailing)
                }
                Text("let session = sidebar.selectedSession")
                    .font(.system(size: store.monoFontSize, design: .monospaced))
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary.opacity(0.24), in: RoundedRectangle(cornerRadius: 7))
            }
        }
    }
}

struct NotificationsSettingsPane: View {
    @State private var completion = true
    @State private var failure = true
    @State private var sound = "系统默认"
    @State private var focusMode = true

    var body: some View {
        SettingsPaneContainer {
            Section("会话通知") {
                Toggle("任务完成时通知", isOn: $completion)
                Toggle("任务失败时通知", isOn: $failure)
                Picker("提示音", selection: $sound) {
                    Text("系统默认").tag("系统默认")
                    Text("Glass").tag("Glass")
                    Text("无声").tag("无声")
                }
            }
            Section("专注模式") {
                Toggle("镜像系统专注模式", isOn: $focusMode)
                Text("开启后，系统专注模式激活时 Pilo 会降低非关键通知优先级。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

struct ShortcutsSettingsPane: View {
    var body: some View {
        SettingsPaneContainer {
            Section("全局") {
                ShortcutRow(name: "命令面板", shortcut: "⌘K")
                ShortcutRow(name: "设置", shortcut: "⌘,")
                ShortcutRow(name: "新建会话", shortcut: "⌘N")
                ShortcutRow(name: "切换侧边栏", shortcut: "⌃⌘S")
            }
            Section("对话") {
                ShortcutRow(name: "发送消息", shortcut: "Enter")
                ShortcutRow(name: "发送消息（备选）", shortcut: "⌘Enter")
                ShortcutRow(name: "停止当前运行", shortcut: "⌘.")
            }
        }
    }
}

struct ShortcutRow: View {
    let name: String
    let shortcut: String

    var body: some View {
        HStack {
            Text(name)
            Spacer()
            Text(shortcut)
                .font(.callout)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 5))
        }
    }
}

struct SettingsConnection: Identifiable {
    let id = UUID()
    let name: String
    let type: String
    let detail: String
    let connected: Bool
}

struct ConnectionsSettingsPane: View {
    private let connections = [
        SettingsConnection(name: "本机", type: "Local", detail: "/Users/devin", connected: true),
        SettingsConnection(name: "devbox", type: "SSH", detail: "devbox.local · 22", connected: true),
        SettingsConnection(name: "Ubuntu", type: "WSL", detail: "Ubuntu-24.04", connected: false)
    ]

    var body: some View {
        SettingsPaneContainer {
            Section("运行环境") {
                ForEach(connections) { connection in
                    HStack(spacing: 10) {
                        Image(systemName: connection.type == "SSH" ? "network" : "laptopcomputer")
                            .frame(width: 20)
                            .foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(connection.name)
                            Text("\(connection.type) · \(connection.detail)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Circle()
                            .fill(connection.connected ? .green : .secondary.opacity(0.45))
                            .frame(width: 7, height: 7)
                        Text(connection.connected ? "已连接" : "未连接")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Button("配置") {}
                            .controlSize(.small)
                    }
                }
                HStack {
                    Button("添加 SSH 连接…") {}
                    Spacer()
                    Button("检测 WSL") {}
                }
            }
        }
    }
}

struct InputSuggestionsSettingsPane: View {
    @State private var files = true
    @State private var sessions = true
    @State private var commands = true
    @State private var maxItems = 8.0

    var body: some View {
        SettingsPaneContainer {
            Section("触发内容") {
                Toggle("@ 文件建议", isOn: $files)
                Toggle("# 会话建议", isOn: $sessions)
                Toggle("/ 命令建议", isOn: $commands)
            }
            Section("列表行为") {
                HStack {
                    Text("最多显示")
                    Spacer()
                    Slider(value: $maxItems, in: 4...16, step: 1)
                        .frame(width: 210)
                    Text("\(Int(maxItems)) 项")
                        .monospacedDigit()
                        .frame(width: 48, alignment: .trailing)
                }
            }
        }
    }
}

struct DraftOptimizationSettingsPane: View {
    @State private var enabled = true
    @State private var model = "gpt-6.2-mini"
    @State private var preserveMentions = true

    var body: some View {
        SettingsPaneContainer {
            Section("草稿优化") {
                Toggle("启用草稿优化", isOn: $enabled)
                Picker("优化模型", selection: $model) {
                    Text("gpt-6.2-mini").tag("gpt-6.2-mini")
                    Text("gpt-6.2-sol").tag("gpt-6.2-sol")
                }
                Toggle("保留 @ 文件提及", isOn: $preserveMentions)
            }
            Section("提示词") {
                TextEditor(text: .constant("把草稿改写为清晰、直接、可执行的开发任务，不要扩大需求范围。"))
                    .font(.body)
                    .frame(height: 96)
            }
        }
    }
}

struct CacheKeepAliveSettingsPane: View {
    @State private var enabled = true
    @State private var interval = "10 分钟"
    @State private var batteryAware = true

    var body: some View {
        SettingsPaneContainer {
            Section("缓存保活") {
                Toggle("启用缓存保活", isOn: $enabled)
                Picker("请求间隔", selection: $interval) {
                    Text("5 分钟").tag("5 分钟")
                    Text("10 分钟").tag("10 分钟")
                    Text("30 分钟").tag("30 分钟")
                }
                Toggle("使用电池时暂停", isOn: $batteryAware)
            }
            Section("运行状态") {
                LabeledContent("当前策略", value: "仅保活最近 3 个项目")
                LabeledContent("下次请求", value: "14:52")
                LabeledContent("本月节省", value: "约 18% 上下文重建成本")
            }
        }
    }
}

struct SessionNamingSettingsPane: View {
    @State private var automatic = true
    @State private var language = "跟随界面语言"
    @State private var template = "{project} · {summary}"

    var body: some View {
        SettingsPaneContainer {
            Section("自动命名") {
                Toggle("根据首轮对话自动生成标题", isOn: $automatic)
                Picker("标题语言", selection: $language) {
                    Text("跟随界面语言").tag("跟随界面语言")
                    Text("中文").tag("中文")
                    Text("英文").tag("英文")
                }
                TextField("命名模板", text: $template)
            }
            Section("示例") {
                Text("pilo · review下未提交的修改")
                    .foregroundStyle(.secondary)
            }
        }
    }
}

struct AboutSettingsPane: View {
    var body: some View {
        SettingsPaneContainer {
            Section("Pilo") {
                HStack(spacing: 13) {
                    RoundedRectangle(cornerRadius: 12)
                        .fill(.orange.gradient)
                        .frame(width: 52, height: 52)
                        .overlay {
                            Image(systemName: "bubble.left.and.bubble.right.fill")
                                .foregroundStyle(.white)
                        }
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Pilo macOS Native Prototype")
                            .font(.headline)
                        Text("版本 0.1.0（SwiftUI 原型）")
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                LabeledContent("构建", value: "Swift Package · macOS 14+")
                LabeledContent("后端", value: "Mock 数据，无 pilo-server 依赖")
            }
            Section("资源") {
                Button("查看 macOS Human Interface Guidelines") {}
                Button("提交原型反馈") {}
            }
        }
    }
}
