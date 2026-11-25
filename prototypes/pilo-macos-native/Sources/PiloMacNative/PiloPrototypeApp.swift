import AppKit
import SwiftUI

extension Notification.Name {
    static let showCommandPalette = Notification.Name("showCommandPalette")
}

@main
struct PiloMacNativePrototypeApp: App {
    @StateObject private var store = PrototypeStore()

    init() {
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    var body: some Scene {
        WindowGroup("Pilo", id: "main") {
            MainWindowView()
                .environmentObject(store)
                .frame(minWidth: 1060, minHeight: 680)
                .preferredColorScheme(store.appearance.colorScheme)
                .tint(store.accentOption.color)
        }
        .windowToolbarStyle(.unified)
        .commands {
            CommandGroup(after: .sidebar) {
                Button("命令面板") {
                    NotificationCenter.default.post(name: .showCommandPalette, object: nil)
                }
                .keyboardShortcut("k", modifiers: .command)
            }
        }

        Settings {
            SettingsRootView()
                .environmentObject(store)
                .preferredColorScheme(store.appearance.colorScheme)
                .tint(store.accentOption.color)
        }
    }
}
