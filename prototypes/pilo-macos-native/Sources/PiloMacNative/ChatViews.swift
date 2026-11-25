import AppKit
import SwiftUI

struct ChatDetailView: View {
    @EnvironmentObject private var store: PrototypeStore

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        ForEach(transcript) { message in
                            Group {
                                if message.role == .user {
                                    UserMessageView(text: message.body)
                                } else {
                                    AssistantMessageView(message: message)
                                }
                            }
                            .id(message.id)
                        }
                    }
                    .padding(.horizontal, 28)
                    .padding(.vertical, 24)
                    .frame(maxWidth: 860)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: transcript.count) { _, _ in
                    scrollToEnd(proxy)
                }
                .onChange(of: transcript.last?.body.count ?? 0) { _, _ in
                    scrollToEnd(proxy)
                }
            }

            ComposerView()
                .padding(.horizontal, 22)
                .padding(.top, 4)
                .padding(.bottom, 16)
        }
        .background(Color(nsColor: .textBackgroundColor))
    }

    private var transcript: [ChatEntry] {
        store.messages(for: store.selectedSessionID)
    }

    private func scrollToEnd(_ proxy: ScrollViewProxy) {
        guard let last = transcript.last else { return }
        withAnimation(.easeOut(duration: 0.18)) {
            proxy.scrollTo(last.id, anchor: .bottom)
        }
    }
}

struct UserMessageView: View {
    let text: String

    var body: some View {
        HStack {
            Spacer(minLength: 130)
            Text(text)
                .font(.body)
                .foregroundStyle(.white)
                .padding(.horizontal, 13)
                .padding(.vertical, 9)
                .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity)
    }
}

struct AssistantMessageView: View {
    let message: ChatEntry
    @State private var thinkingExpanded = false
    @State private var toolsExpanded = true
    @State private var outputExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            DisclosureGroup(isExpanded: $thinkingExpanded) {
                VStack(alignment: .leading, spacing: 7) {
                    ThoughtRow(text: "读取暂存、未暂存与未跟踪改动清单", done: true)
                    ThoughtRow(text: "追踪会话行选中态与未读标识的调用链", done: true)
                    ThoughtRow(text: "汇总回归风险并给出审查结论", done: true)
                }
                .padding(.leading, 24)
                .padding(.top, 4)
            } label: {
                Label("工作了 36 秒", systemImage: "checkmark.circle.fill")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .tint(.secondary)

            DisclosureGroup(isExpanded: $toolsExpanded) {
                VStack(spacing: 7) {
                    ToolCallRow(
                        icon: "chevron.left.slash.chevron.right",
                        title: "codemode",
                        detail: "分析未提交改动",
                        status: .success,
                        expanded: $outputExpanded
                    )
                    ToolCallRow(
                        icon: "terminal",
                        title: "运行",
                        detail: "git diff HEAD; git diff --check; git ls-files .trellis/spec",
                        status: .failed,
                        expanded: .constant(false)
                    )
                }
                .padding(.leading, 24)
                .padding(.top, 4)
            } label: {
                Label("执行 2 个命令", systemImage: "terminal")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .tint(.secondary)

            VStack(alignment: .leading, spacing: 13) {
                Text(message.body)
                    .font(.body)
                    .foregroundStyle(.primary)
                    .lineSpacing(4)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if message.isStreaming {
                    HStack(spacing: 6) {
                        ProgressView()
                            .controlSize(.small)
                        Text("正在输入…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                MarkdownSampleBlock()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct ThoughtRow: View {
    let text: String
    let done: Bool

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle")
                .font(.caption)
                .foregroundStyle(done ? .green : .secondary)
            Text(text)
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }
}

enum ToolStatus {
    case success
    case failed
}

struct ToolCallRow: View {
    let icon: String
    let title: String
    let detail: String
    let status: ToolStatus
    @Binding var expanded: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                if status == .success {
                    withAnimation(.snappy) { expanded.toggle() }
                }
            } label: {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: icon)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(width: 16)
                    Text(title)
                        .font(.system(.callout, design: .monospaced))
                        .foregroundStyle(status == .failed ? .red : .secondary)
                    Text(detail)
                        .font(.system(.callout, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer()
                    Image(systemName: status == .failed ? "exclamationmark.circle.fill" : "chevron.right")
                        .font(.caption)
                        .foregroundStyle(status == .failed ? Color.red : Color.secondary)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if status == .failed {
                Text("已停止")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 24)
                    .padding(.top, 3)
            }

            if expanded {
                Text("diff --git a/app/shell/Sidebar.tsx b/app/shell/Sidebar.tsx\nindex 4ba8e3d..09d421f 100644\n@@ const selected = computed(() => {\n+  return sessionRowKey(current) === open?.rowKey")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .padding(9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary.opacity(0.28), in: RoundedRectangle(cornerRadius: 7))
                    .padding(.leading, 24)
                    .padding(.top, 6)
            }
        }
    }
}

struct MarkdownSampleBlock: View {
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("审查结论")
                    .font(.headline)
                Spacer()
                Button {
                    copyMarkdown()
                } label: {
                    Label(copied ? "已复制" : "复制", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.caption)
                }
                .buttonStyle(.borderless)
            }

            Text("主要风险不在 diff 本身，而在会话行复用后仍沿用旧的展开与菜单状态。")
                .font(.callout)
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("Swift")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.quaternary.opacity(0.32))

                Text("if selectedSession.id == row.id {\n    row.markRead()\n}")
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay {
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(.quaternary)
            }
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 11))
    }

    private func copyMarkdown() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("## 审查结论\n\n主要风险不在 diff 本身。", forType: .string)
        copied = true
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.4))
            copied = false
        }
    }
}
