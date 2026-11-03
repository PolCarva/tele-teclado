// Google Play images from the App Store ones: screenshots padded to 2:1 (Play's maximum ratio) and
// the 1024x500 feature graphic. Run: swift store/play/make-assets.swift  (from the repo root)
import AppKit

func load(_ path: String) -> NSBitmapImageRep { NSBitmapImageRep(data: try! Data(contentsOf: URL(fileURLWithPath: path)))! }

func save(_ rep: NSBitmapImageRep, _ path: String) {
  // Opaque RGB PNG.
  let cg = rep.cgImage!
  let ctx = CGContext(data: nil, width: cg.width, height: cg.height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  ctx.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
  try! NSBitmapImageRep(cgImage: ctx.makeImage()!).representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
  print("wrote \(path)")
}

func canvas(_ w: Int, _ h: Int, _ draw: () -> Void) -> NSBitmapImageRep {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  rep.size = NSSize(width: w, height: h)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  draw()
  NSGraphicsContext.restoreGraphicsState()
  return rep
}

// Screenshots: 1320x2868 -> 1434x2868 (2:1), stretching each edge column sideways (the background is a
// vertical gradient, so this is seamless).
for name in ["1-escribir", "2-conectar", "3-vincular"] {
  let src = load("store/screenshots/iphone-6.9/\(name).png")
  let w = src.pixelsWide, h = src.pixelsHigh
  let pad = (h / 2 - w + 1) / 2
  let img = NSImage(size: NSSize(width: w, height: h))
  img.addRepresentation(src)
  let out = canvas(w + 2 * pad, h) {
    img.draw(in: NSRect(x: 0, y: 0, width: pad, height: h), from: NSRect(x: 0, y: 0, width: 1, height: h), operation: .copy, fraction: 1)
    img.draw(in: NSRect(x: pad + w, y: 0, width: pad, height: h), from: NSRect(x: w - 1, y: 0, width: 1, height: h), operation: .copy, fraction: 1)
    img.draw(in: NSRect(x: pad, y: 0, width: w, height: h), from: .zero, operation: .copy, fraction: 1)
  }
  save(out, "store/play/\(name).png")
}

// Feature graphic 1024x500: the app's dark navy, its icon and a line about what it does.
func color(_ hex: UInt32) -> NSColor { NSColor(deviceRed: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: 1) }
let icon = NSImage(contentsOfFile: "assets/icon.png")!
let feature = canvas(1024, 500) {
  NSGradient(colors: [color(0x16264A), color(0x0A0C10)])!.draw(in: NSRect(x: 0, y: 0, width: 1024, height: 500), angle: -60)
  let iconRect = NSRect(x: 80, y: 130, width: 240, height: 240)
  NSGraphicsContext.saveGraphicsState()
  NSBezierPath(roundedRect: iconRect, xRadius: 54, yRadius: 54).addClip()
  icon.draw(in: iconRect)
  NSGraphicsContext.restoreGraphicsState()
  let title = NSAttributedString(string: "Teclado TV", attributes: [.font: NSFont.systemFont(ofSize: 72, weight: .bold), .foregroundColor: color(0xF2F5FA), .kern: -1])
  title.draw(at: NSPoint(x: 370, y: 262))
  let sub = NSAttributedString(string: "Escribí en la tele\ncon el teclado del celular", attributes: [.font: NSFont.systemFont(ofSize: 36, weight: .regular), .foregroundColor: color(0xA9B3C4)])
  sub.draw(in: NSRect(x: 372, y: 130, width: 620, height: 120))
}
save(feature, "store/play/feature-graphic.png")
