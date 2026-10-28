import Cocoa

// 用法：swift extract-icons.swift <输出目录>
// 从本机装的官方 Claude / ChatGPT 应用里取出它们的图标（和访达里看到的一样），存成 claude.png / gpt.png。
// 图标不放进代码仓库，每台电脑打包时从自己装的官方应用里取；没装就继续用内置的简笔头像。

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icons"
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

let apps: [(String, [String])] = [
    ("claude", ["/Applications/Claude.app", NSHomeDirectory() + "/Applications/Claude.app"]),
    ("gpt", ["/Applications/ChatGPT.app", NSHomeDirectory() + "/Applications/ChatGPT.app"]),
]

let px = 256
for (name, paths) in apps {
    guard let path = paths.first(where: { FileManager.default.fileExists(atPath: $0) }) else {
        print("没找到 \(name) 的官方应用，跳过")
        continue
    }
    let icon = NSWorkspace.shared.icon(forFile: path)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    // macOS 图标四周有约 10% 的透明留白，放大一点裁掉留白，头像里图标才饱满
    let scale = 1024.0 / 824.0
    let side = CGFloat(px) * scale
    let offset = (CGFloat(px) - side) / 2
    icon.draw(in: NSRect(x: offset, y: offset, width: side, height: side), from: .zero, operation: .sourceOver, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    let file = "\(outDir)/\(name).png"
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: file))
    print("✓ \(name) 图标来自 \(path)")
}
