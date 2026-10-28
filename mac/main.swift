import Cocoa
import UniformTypeIdentifiers
import WebKit

// ClawChat 的原生外壳：启动本地服务（server.js），用 WKWebView 打开界面。
// 关闭窗口不退出（两位可以继续在后台干活），⌘Q 退出时一并停掉服务。

// 盖在网页上面的一层：只在网页报告的「可拖动区域」里接住鼠标，用来拖动和双击缩放窗口，其他地方透传给网页
final class DragView: NSView {
    var drag: [NSRect] = []
    var nodrag: [NSRect] = []
    override var isFlipped: Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let p = convert(point, from: superview)
        guard drag.contains(where: { $0.contains(p) }), !nodrag.contains(where: { $0.contains(p) }) else { return nil }
        return self
    }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            window?.performZoom(nil)
        } else {
            window?.performDrag(with: event)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    let dragView = DragView()
    var server: Process?
    let port = Int(ProcessInfo.processInfo.environment["CLAWCHAT_PORT"] ?? "") ?? 7317
    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)/")! }
    let logURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".clawchat/server.log")

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMenu()
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "clawchat")
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1120, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "ClawChat"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.minSize = NSSize(width: 760, height: 520)
        window.isReleasedWhenClosed = false

        // 底层是系统的侧栏毛玻璃，网页背景透明，侧栏透出毛玻璃，聊天区自己画不透明背景
        let container = NSView()
        let vibrancy = NSVisualEffectView()
        vibrancy.material = .sidebar
        vibrancy.blendingMode = .behindWindow
        vibrancy.state = .followsWindowActiveState
        for v in [vibrancy, webView!, dragView] as [NSView] {
            v.autoresizingMask = [.width, .height]
            container.addSubview(v)
        }
        window.contentView = container
        for v in container.subviews { v.frame = container.bounds }
        applyTheme(UserDefaults.standard.string(forKey: "theme") ?? "system")
        window.center()
        window.setFrameAutosaveName("ClawChatMainWindow")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        webView.loadHTMLString(statusPage("正在启动…"), baseURL: nil)
        checkHealth { ok in
            if ok {
                self.loadApp()
            } else {
                self.launchServer()
                self.waitForServer(attempts: 160)
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let p = server, p.isRunning {
            p.terminate()
            p.waitUntilExit()
        }
    }

    // 浅色 / 深色 / 跟随系统：窗口外观决定毛玻璃、红绿灯和系统控件的颜色
    func applyTheme(_ value: String) {
        switch value {
        case "light": window.appearance = NSAppearance(named: .aqua)
        case "dark": window.appearance = NSAppearance(named: .darkAqua)
        default: window.appearance = nil
        }
    }

    // MARK: 本地服务

    func loadApp() { webView.load(URLRequest(url: baseURL)) }

    func checkHealth(_ done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/health"))
        req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }

    func launchServer() {
        let info = Bundle.main.infoDictionary ?? [:]
        guard let node = info["ClawChatNode"] as? String, let root = info["ClawChatRoot"] as? String else {
            webView.loadHTMLString(statusPage("应用配置不完整，请在项目目录重新运行 npm run app"), baseURL: nil)
            return
        }
        guard FileManager.default.fileExists(atPath: root + "/server.js") else {
            webView.loadHTMLString(statusPage("找不到 \(root)/server.js。项目文件夹被移动过的话，请在新位置重新运行 npm run app"), baseURL: nil)
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [root + "/server.js"]
        p.currentDirectoryURL = URL(fileURLWithPath: root)
        var env = ProcessInfo.processInfo.environment
        env["CLAWCHAT_PORT"] = String(port)
        env["CLAWCHAT_APP"] = "1" // 告诉服务它在应用里运行：在线升级后由脚本重新打包并重开应用
        p.environment = env
        try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        if let fh = try? FileHandle(forWritingTo: logURL) {
            fh.seekToEndOfFile()
            p.standardOutput = fh
            p.standardError = fh
        }
        do {
            try p.run()
            server = p
        } catch {
            webView.loadHTMLString(statusPage("启动本地服务失败：\(error.localizedDescription)"), baseURL: nil)
        }
    }

    func waitForServer(attempts: Int) {
        checkHealth { ok in
            if ok {
                self.loadApp()
            } else if attempts > 0, self.server?.isRunning ?? false {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.waitForServer(attempts: attempts - 1) }
            } else {
                self.webView.loadHTMLString(self.statusPage("本地服务没有启动成功，日志在 ~/.clawchat/server.log"), baseURL: nil)
            }
        }
    }

    func statusPage(_ text: String) -> String {
        let safe = text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        return """
        <html><body style="margin:0;height:100vh;display:grid;place-items:center;font:14px -apple-system,'PingFang SC',sans-serif;color:#8a8a8a;background:transparent">\(safe)</body></html>
        """
    }

    // MARK: 和网页通信

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "badge":
            let n = body["count"] as? Int ?? 0
            NSApp.dockTile.badgeLabel = n > 0 ? String(n) : nil
        case "attention":
            NSApp.requestUserAttention(.informationalRequest)
        case "theme":
            let value = body["value"] as? String ?? "system"
            UserDefaults.standard.set(value, forKey: "theme")
            applyTheme(value)
        case "dragRegions":
            func rects(_ key: String) -> [NSRect] {
                (body[key] as? [[Double]] ?? []).compactMap { r in r.count == 4 ? NSRect(x: r[0], y: r[1], width: r[2], height: r[3]) : nil }
            }
            dragView.drag = rects("drag")
            dragView.nodrag = rects("nodrag")
        case "pickFolder":
            let id = body["id"] as? String ?? ""
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.canCreateDirectories = true
            panel.allowsMultipleSelection = false
            panel.prompt = "选择"
            panel.message = "选择项目文件夹"
            panel.beginSheetModal(for: window) { resp in
                let path = resp == .OK ? panel.url?.path : nil
                let args: [Any] = [id, path ?? NSNull()]
                if let data = try? JSONSerialization.data(withJSONObject: args), let json = String(data: data, encoding: .utf8) {
                    self.webView.evaluateJavaScript("window.__clawchatPicked(...\(json))")
                }
            }
        default:
            break
        }
    }

    // MARK: 导航：外部链接用默认浏览器打开

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, let scheme = url.scheme, ["http", "https", "mailto"].contains(scheme),
           !(url.host == "127.0.0.1" && url.port == port) {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // 网页里的 <input type="file">（发图片）需要外壳弹出选择框
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.allowedContentTypes = [.image]
        panel.prompt = "发送"
        panel.beginSheetModal(for: window) { resp in
            completionHandler(resp == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { loadApp() }

    // MARK: 菜单（没有「编辑」菜单的话，⌘C / ⌘V 在网页里不生效）

    @objc func reloadPage(_ sender: Any?) { loadApp() }

    @objc func openSettings(_ sender: Any?) {
        window.makeKeyAndOrderFront(nil)
        webView.evaluateJavaScript("window.__clawchatOpenSettings && window.__clawchatOpenSettings()")
    }

    @objc func checkForUpdates(_ sender: Any?) {
        window.makeKeyAndOrderFront(nil)
        webView.evaluateJavaScript("window.__clawchatOpenSettings && window.__clawchatOpenSettings('update')")
    }

    func setupMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 ClawChat", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        let update = NSMenuItem(title: "检查更新…", action: #selector(checkForUpdates(_:)), keyEquivalent: "")
        update.target = self
        appMenu.addItem(update)
        appMenu.addItem(.separator())
        let settings = NSMenuItem(title: "设置…", action: #selector(openSettings(_:)), keyEquivalent: ",")
        settings.target = self
        appMenu.addItem(settings)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 ClawChat", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 ClawChat", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "编辑")
        edit.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "显示")
        let reload = NSMenuItem(title: "重新载入", action: #selector(reloadPage(_:)), keyEquivalent: "r")
        reload.target = self
        view.addItem(reload)
        viewItem.submenu = view
        main.addItem(viewItem)

        let windowItem = NSMenuItem()
        let win = NSMenu(title: "窗口")
        win.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = win
        main.addItem(windowItem)

        NSApp.mainMenu = main
        NSApp.windowsMenu = win
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
