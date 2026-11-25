import AppKit
import SwiftUI

struct ComposerView: View {
    @EnvironmentObject private var store: PrototypeStore
    @State private var draft = ""
    @State private var model = "gpt-6.2-sol"
    @State private var reasoning = "High"
    @State private var sendMode = "直接发送"

    var body: some View {
        VStack(spacing: 7) {
            ZStack(alignment: .topLeading) {
                ComposerTextEditor(
                    text: $draft,
                    sendWithEnter: store.sendKey == "Enter",
                    onSend: send
                )
                .frame(height: inputHeight)

                if draft.isEmpty {
                    Text("给 Pi 发消息，@ 提及文件")
                        .font(.body)
                        .foregroundStyle(.tertiary)
                        .padding(.leading, 8)
                        .padding(.top, 10)
                        .allowsHitTesting(false)
                }
            }

            HStack(spacing: 9) {
                Menu {
                    Button("提及文件") { appendToken("@") }
                    Button("提及会话") { appendToken("#") }
                    Divider()
                    Button("添加附件…") { appendToken("[附件] ") }
                } label: {
                    Image(systemName: "plus")
                        .frame(width: 25, height: 25)
                }
                .menuStyle(.borderlessButton)
                .help("添加附件或提及")

                Menu {
                    Button("gpt-6.2-sol") { model = "gpt-6.2-sol" }
                    Button("gpt-6.2-mini") { model = "gpt-6.2-mini" }
                    Button("claude-sonnet-4.5") { model = "claude-sonnet-4.5" }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "cpu")
                        Text(model)
                            .lineLimit(1)
                    }
                }
                .menuStyle(.borderlessButton)
                .help("选择模型")

                Menu {
                    ForEach(["Low", "Medium", "High"], id: \.self) { item in
                        Button(item) { reasoning = item }
                    }
                } label: {
                    Text("· \(reasoning)")
                }
                .menuStyle(.borderlessButton)
                .help("推理强度")

                Spacer(minLength: 8)

                ContextUsageRing(value: store.contextUsage)

                Button {
                    optimizeDraft()
                } label: {
                    Image(systemName: "sparkles")
                        .frame(width: 25, height: 25)
                }
                .buttonStyle(.borderless)
                .help("草稿优化")

                Menu {
                    Button("直接发送") { sendMode = "直接发送" }
                    Button("排队为 Follow-up") { sendMode = "排队" }
                    Button("Steer 当前运行") { sendMode = "Steer" }
                } label: {
                    Image(systemName: "chevron.down")
                        .font(.caption)
                        .frame(width: 19, height: 25)
                }
                .menuStyle(.borderlessButton)
                .help("发送模式：\(sendMode)")

                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(.white)
                        .frame(width: 27, height: 27)
                        .background(canSend ? Color.accentColor : Color.secondary.opacity(0.35), in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .keyboardShortcut(.return, modifiers: .command)
                .help(store.sendKey == "Enter" ? "Enter 发送，Shift+Enter 换行" : "⌘Enter 发送")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 15, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.12), lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.08), radius: 8, y: 2)
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var inputHeight: CGFloat {
        let lines = max(1, draft.components(separatedBy: .newlines).count)
        return min(138, max(52, CGFloat(lines) * 20 + 20))
    }

    private func appendToken(_ token: String) {
        if !draft.isEmpty && !draft.hasSuffix(" ") && !draft.hasSuffix("\n") {
            draft += " "
        }
        draft += token
    }

    private func optimizeDraft() {
        guard canSend else { return }
        draft = "请优化以下内容并保持原意：\n" + draft
    }

    private func send() {
        guard canSend else { return }
        store.sendMessage(draft)
        draft = ""
    }
}

struct ContextUsageRing: View {
    let value: Double

    var body: some View {
        ZStack {
            Circle()
                .stroke(Color.secondary.opacity(0.18), lineWidth: 3)
            Circle()
                .trim(from: 0, to: value)
                .stroke(value > 0.8 ? Color.orange : Color.accentColor, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text(value.formatted(.percent.precision(.fractionLength(1))))
                .font(.system(size: 8, weight: .medium))
                .foregroundStyle(.secondary)
        }
        .frame(width: 29, height: 29)
        .help("上下文用量")
    }
}

final class InterceptingTextView: NSTextView {
    var onSend: (() -> Void)?
    var sendWithEnter = true

    override func keyDown(with event: NSEvent) {
        let isReturn = event.keyCode == 36 || event.keyCode == 76
        guard isReturn else {
            super.keyDown(with: event)
            return
        }

        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if modifiers.contains(.shift) {
            super.keyDown(with: event)
            return
        }

        if modifiers.contains(.command) || (sendWithEnter && modifiers.isEmpty) {
            onSend?()
            return
        }

        super.keyDown(with: event)
    }
}

struct ComposerTextEditor: NSViewRepresentable {
    @Binding var text: String
    var sendWithEnter: Bool
    var onSend: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = InterceptingTextView()
        textView.onSend = onSend
        textView.sendWithEnter = sendWithEnter
        textView.delegate = context.coordinator
        textView.font = .systemFont(ofSize: 14)
        textView.isRichText = false
        textView.importsGraphics = false
        textView.usesFontPanel = false
        textView.usesRuler = false
        textView.drawsBackground = false
        textView.textContainerInset = NSSize(width: 4, height: 8)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)

        let scrollView = NSScrollView()
        scrollView.documentView = textView
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        context.coordinator.textView = textView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = context.coordinator.textView else { return }
        textView.onSend = onSend
        textView.sendWithEnter = sendWithEnter
        if textView.string != text {
            textView.string = text
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        @Binding var text: String
        weak var textView: InterceptingTextView?

        init(text: Binding<String>) {
            _text = text
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            text = textView.string
        }
    }
}
