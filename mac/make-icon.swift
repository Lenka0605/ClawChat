import Cocoa

// 用法：swift make-icon.swift <输出的 .iconset 目录>
// 画一个绿色圆角方块，上面一个白色对话气泡，气泡里三个点：Claude（橙）、GPT（黑）、你（绿）

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "ClawChat.iconset"
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

func color(_ hex: UInt32) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
}

func render(_ px: Int) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(px)

    let inset = s * 0.09
    let tile = NSRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
    let bg = NSBezierPath(roundedRect: tile, xRadius: tile.width * 0.225, yRadius: tile.width * 0.225)
    NSGradient(starting: color(0x2fd27a), ending: color(0x07a854))!.draw(in: bg, angle: -90)

    let bw = tile.width * 0.66, bh = tile.width * 0.46
    let bubble = NSRect(x: tile.midX - bw / 2, y: tile.midY - bh / 2 + tile.width * 0.04, width: bw, height: bh)
    let path = NSBezierPath(roundedRect: bubble, xRadius: bh * 0.36, yRadius: bh * 0.36)
    let tail = NSBezierPath()
    tail.move(to: NSPoint(x: bubble.minX + bw * 0.2, y: bubble.minY + 1))
    tail.line(to: NSPoint(x: bubble.minX + bw * 0.13, y: bubble.minY - bh * 0.26))
    tail.line(to: NSPoint(x: bubble.minX + bw * 0.38, y: bubble.minY + 1))
    tail.close()
    NSColor.white.setFill()
    path.fill()
    tail.fill()

    let r = bh * 0.13
    let colors = [color(0xd97757), color(0x262626), color(0x07c160)]
    for (i, c) in colors.enumerated() {
        let cx = bubble.midX + CGFloat(i - 1) * r * 3.1
        c.setFill()
        NSBezierPath(ovalIn: NSRect(x: cx - r, y: bubble.midY - r, width: r * 2, height: r * 2)).fill()
    }

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let sizes: [(String, Int)] = [
    ("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024),
]
for (name, px) in sizes {
    try! render(px).write(to: URL(fileURLWithPath: "\(outDir)/\(name).png"))
}
