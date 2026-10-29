import Cocoa

// 用法：swift make-icon.swift <输出的 .iconset 目录>   打包 Mac 应用时用（scripts/build-app.sh 会调用）
//      swift make-icon.swift --windows              重新生成 public/favicon.png 和 windows/ClawChat.ico
// 图标原图是同目录的 icon-art.jpg（用 ChatGPT 生图画的液态玻璃对话气泡），这里只负责裁成各处要的形状和尺寸：
// Mac 按系统图标的规格四周留边、圆角、带一点投影；Windows 和网页图标留边少一些，缩得很小时也饱满。
// 换图标时替换 icon-art.jpg（1024×1024，画面铺满、不留边、不带圆角），再运行一次 --windows，把生成的两个文件一起提交。

let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let root = here.deletingLastPathComponent()
guard let art = NSImage(contentsOf: here.appendingPathComponent("icon-art.jpg")) else {
    FileHandle.standardError.write("找不到 icon-art.jpg\n".data(using: .utf8)!)
    exit(1)
}

func render(_ px: Int, mac: Bool) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    let s = CGFloat(px)

    // Mac 图标：1024 的画布里放 824 的圆角方块（和系统自带的应用一样大）；Windows 只留 4% 的边
    let inset = mac ? s * 100 / 1024 : s * 0.04
    let tile = NSRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
    let shape = NSBezierPath(roundedRect: tile, xRadius: tile.width * 0.225, yRadius: tile.width * 0.225)
    if mac {
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor(white: 0, alpha: 0.3)
        shadow.shadowBlurRadius = s * 0.02
        shadow.shadowOffset = NSSize(width: 0, height: -s * 0.01)
        shadow.set()
        NSColor.black.setFill()
        shape.fill()
        NSGraphicsContext.restoreGraphicsState()
    }
    shape.addClip()
    art.draw(in: tile)

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

// .ico 文件：文件头 + 每个尺寸一条目录 + 各尺寸的 PNG（Windows Vista 起支持 PNG 格式的图标）
func ico(_ sizes: [Int]) -> Data {
    let images = sizes.map { render($0, mac: false) }
    var d = Data()
    func u16(_ v: Int) { d.append(contentsOf: [UInt8(v & 0xff), UInt8((v >> 8) & 0xff)]) }
    func u32(_ v: Int) { u16(v & 0xffff); u16(v >> 16) }
    u16(0); u16(1); u16(sizes.count)
    var offset = 6 + 16 * sizes.count
    for (px, png) in zip(sizes, images) {
        let side = UInt8(px >= 256 ? 0 : px) // 256 在目录里记成 0
        d.append(contentsOf: [side, side, 0, 0])
        u16(1); u16(32); u32(png.count); u32(offset)
        offset += png.count
    }
    images.forEach { d.append($0) }
    return d
}

if CommandLine.arguments.dropFirst().first == "--windows" {
    try! render(256, mac: false).write(to: root.appendingPathComponent("public/favicon.png"))
    try! ico([16, 24, 32, 48, 64, 128, 256]).write(to: root.appendingPathComponent("windows/ClawChat.ico"))
    exit(0)
}

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "ClawChat.iconset"
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
let sizes: [(String, Int)] = [
    ("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024),
]
for (name, px) in sizes {
    try! render(px, mac: true).write(to: URL(fileURLWithPath: "\(outDir)/\(name).png"))
}
