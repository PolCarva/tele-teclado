// Store art for Teclado TV, drawn from the real app screens in store/art/screens:
//   shots   → 5 screenshots that join into one panorama (App Store 1320x2868 and Google Play 1440x2560)
//   header  → App Store product page header video, 21:9 3840x1646, 10 s loop (+ a still frame)
//   feature → Google Play feature graphic 1024x500 (same scene as the header)
//   search  → App Store search results video, 3:2 3600x2400, 15.5 s: typing with the remote, then with the phone
// Run from the repo root: swift store/art/make-art.swift shots|header|search|feature|all [previewDir]
// The video needs ffmpeg (brew install ffmpeg).
import AppKit

// MARK: - Basics

func color(_ hex: UInt32, _ a: CGFloat = 1) -> NSColor {
  NSColor(srgbRed: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: a)
}
let accent = color(0x8AB4F8), blue = color(0x2F6BFF), orange = color(0xFFA057), ink = color(0xF2F5FA), muted = color(0xA9B3C4)

func clamp(_ x: CGFloat, _ lo: CGFloat = 0, _ hi: CGFloat = 1) -> CGFloat { min(hi, max(lo, x)) }
func ease(_ t: CGFloat) -> CGFloat { t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2 }
func lerp(_ a: CGFloat, _ b: CGFloat, _ t: CGFloat) -> CGFloat { a + (b - a) * t }
func rr(_ r: NSRect, _ radius: CGFloat) -> NSBezierPath { NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius) }
func fill(_ r: NSRect, _ radius: CGFloat, _ c: NSColor) { c.setFill(); rr(r, radius).fill() }
func ring(_ r: NSRect, _ radius: CGFloat, _ c: NSColor, _ w: CGFloat) { c.setStroke(); let p = rr(r, radius); p.lineWidth = w; p.stroke() }
func circle(_ c: NSPoint, _ r: CGFloat, _ col: NSColor) { col.setFill(); NSBezierPath(ovalIn: NSRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)).fill() }
func saved(_ f: () -> Void) { NSGraphicsContext.saveGraphicsState(); f(); NSGraphicsContext.restoreGraphicsState() }
var cg: CGContext { NSGraphicsContext.current!.cgContext }
// Shadow offsets are in device space (y up), so a negative dy drops the shadow.
func shadowed(_ blur: CGFloat, _ dy: CGFloat, _ c: NSColor, _ f: () -> Void) {
  saved { let s = NSShadow(); s.shadowBlurRadius = blur; s.shadowOffset = NSSize(width: 0, height: dy); s.shadowColor = c; s.set(); f() }
}
// The context is flipped (y down), so angle 90 runs top to bottom.
func vgrad(_ r: NSRect, _ top: NSColor, _ bottom: NSColor) { NSGradient(starting: top, ending: bottom)!.draw(in: r, angle: 90) }
func glow(_ c: NSPoint, _ radius: CGFloat, _ col: NSColor) {
  NSGradient(starting: col, ending: col.withAlphaComponent(0))!.draw(fromCenter: c, radius: 0, toCenter: c, radius: radius, options: [])
}

func font(_ size: CGFloat, _ w: NSFont.Weight) -> NSFont { NSFont.systemFont(ofSize: size, weight: w) }
func textWidth(_ s: String, _ f: NSFont, kern: CGFloat = 0) -> CGFloat { NSAttributedString(string: s, attributes: [.font: f, .kern: kern]).size().width }
@discardableResult
func text(_ s: String, _ f: NSFont, _ c: NSColor, x: CGFloat, baseline: CGFloat, kern: CGFloat = 0) -> CGFloat {
  let a = NSAttributedString(string: s, attributes: [.font: f, .foregroundColor: c, .kern: kern])
  a.draw(at: NSPoint(x: x, y: baseline - f.ascender))
  return a.size().width
}
func centered(_ s: String, _ f: NSFont, _ c: NSColor, cx: CGFloat, baseline: CGFloat, kern: CGFloat = 0) {
  text(s, f, c, x: cx - textWidth(s, f, kern: kern) / 2, baseline: baseline, kern: kern)
}
func paragraph(_ s: String, _ f: NSFont, _ c: NSColor, _ r: NSRect, lineHeight: CGFloat, kern: CGFloat = 0) {
  let ps = NSMutableParagraphStyle(); ps.alignment = .center; ps.minimumLineHeight = lineHeight; ps.maximumLineHeight = lineHeight
  NSAttributedString(string: s, attributes: [.font: f, .foregroundColor: c, .kern: kern, .paragraphStyle: ps]).draw(with: r, options: [.usesLineFragmentOrigin])
}

// MARK: - Canvas

func makeContext(_ w: Int, _ h: Int) -> CGContext {
  CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
}
func drawInto(_ ctx: CGContext, height: Int, scale: CGFloat, offsetX: CGFloat = 0, _ f: () -> Void) {
  ctx.saveGState()
  ctx.translateBy(x: offsetX, y: CGFloat(height))
  ctx.scaleBy(x: scale, y: -scale)
  let prev = NSGraphicsContext.current
  NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
  f()
  NSGraphicsContext.current = prev
  ctx.restoreGState()
}
// Opaque RGB PNG: the stores reject alpha.
func savePNG(_ img: CGImage, _ path: String) {
  let ctx = CGContext(data: nil, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))
  try! NSBitmapImageRep(cgImage: ctx.makeImage()!).representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
  print("wrote \(path)")
}

// MARK: - Phone (real app screens)

// Real captures: 962x2086 px. Positions below (field, keys, Enter) are in those pixels.
let capW: CGFloat = 962, capH: CGFloat = 2086
let screens: [String: NSImage] = Dictionary(uniqueKeysWithValues: ["escribir", "permitir", "vincular"].map { ($0, NSImage(contentsOfFile: "store/art/screens/\($0).png")!) })
func phoneScreen(x: CGFloat, y: CGFloat, width: CGFloat) -> NSRect { NSRect(x: x, y: y, width: width, height: width * capH / capW) }

func phone(_ screen: NSRect, _ name: String, overlay: (() -> Void)? = nil) {
  let k = screen.width / capW
  let bez = 16 * k, sr = 132 * k
  let body = screen.insetBy(dx: -bez, dy: -bez)
  shadowed(110 * k, -60 * k, color(0x000000, 0.6)) { fill(body, sr + bez, color(0x2A3140)) }
  fill(body, sr + bez, color(0x374153))
  ring(body.insetBy(dx: 2 * k, dy: 2 * k), sr + bez - 2 * k, color(0x5A6680, 0.7), 3 * k)
  saved {
    rr(screen, sr).addClip()
    screens[name]!.draw(in: screen, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    if let overlay {
      cg.translateBy(x: screen.minX, y: screen.minY)
      cg.scaleBy(x: k, y: k)
      overlay()
    }
  }
}

// The typing screen's text field, redrawn so the video can type into it.
let capFont: NSFont = { let f = font(60, .regular); return font(60 * 600 / textWidth("receta de empanadas", f), .regular) }()
let capTextX: CGFloat = 97, capBaseline: CGFloat = 488
func capCaret(_ typed: String) -> NSPoint { NSPoint(x: capTextX + textWidth(typed, capFont) + 3, y: 470) }

func keyRect(_ c: Character) -> NSRect? {
  let rows: [(String, CGFloat, CGFloat)] = [("qwertyuiop", 21, 1391), ("asdfghjkl", 68, 1523), ("zxcvbnm", 161, 1655)]
  for (letters, x0, y0) in rows {
    if let i = letters.firstIndex(of: c) { return NSRect(x: x0 + CGFloat(letters.distance(from: letters.startIndex, to: i)) * 93.55, y: y0, width: 79, height: 104) }
  }
  return c == " " ? NSRect(x: 256, y: 1790, width: 450, height: 104) : nil
}

struct Typing { var text = ""; var caret = true; var key: (NSRect, CGFloat)? = nil; var enter: CGFloat = 0 }
func typingOverlay(_ s: Typing) {
  let fieldBG = color(0x191F29)
  if s.text.isEmpty {
    fill(NSRect(x: 54, y: 375, width: 854, height: 186), 40, fieldBG)
    text("¿Qué querés buscar?", capFont, color(0x626B7A), x: capTextX, baseline: capBaseline)
  } else {
    fill(NSRect(x: 60, y: 380, width: 740, height: 176), 20, fieldBG)
    text(s.text, capFont, .white, x: capTextX, baseline: capBaseline)
  }
  if s.caret { fill(NSRect(x: s.text.isEmpty ? capTextX : capCaret(s.text).x, y: 436, width: 5, height: 68), 2.5, accent) }
  if let (r, v) = s.key { fill(r, 14, color(0xFFFFFF, 0.42 * v)) }
  if s.enter > 0 { fill(NSRect(x: 46, y: 610, width: 870, height: 141), 70, color(0x000000, 0.3 * s.enter)) }
}

// MARK: - TV

func tvScreen(_ r: NSRect) -> NSRect { let u = r.width / 1000; return r.insetBy(dx: 16 * u, dy: 16 * u) }
func tv(_ r: NSRect, stand: Bool = true, content: (NSRect) -> Void) {
  let u = r.width / 1000
  if stand {
    fill(NSRect(x: r.midX - 24 * u, y: r.maxY - 10 * u, width: 48 * u, height: 62 * u), 6 * u, color(0x1C222D))
    shadowed(30 * u, -10 * u, color(0x000000, 0.5)) { fill(NSRect(x: r.midX - 160 * u, y: r.maxY + 46 * u, width: 320 * u, height: 16 * u), 8 * u, color(0x2C3445)) }
  }
  shadowed(80 * u, -36 * u, color(0x000000, 0.6)) { fill(r, 22 * u, color(0x141923)) }
  ring(r.insetBy(dx: 1.5 * u, dy: 1.5 * u), 21 * u, color(0x343D50), 3 * u)
  let s = tvScreen(r)
  saved {
    rr(s, 8 * u).addClip()
    vgrad(s, color(0x15223F), color(0x0A0E17))
    content(s)
    NSGradient(colorsAndLocations: (color(0xFFFFFF, 0.06), 0), (color(0xFFFFFF, 0), 0.5))!.draw(in: s, angle: 30)
  }
}

struct TVSearch { var typed = ""; var alpha: CGFloat = 1; var caret = true; var results: CGFloat = 1; var flash: CGFloat = 0 }
func searchLayout(_ s: NSRect) -> (field: NSRect, textX: CGFloat, baseline: CGFloat, font: NSFont) {
  let u = s.width / 1000
  let field = NSRect(x: s.minX + 70 * u, y: s.minY + 58 * u, width: s.width - 140 * u, height: 96 * u)
  return (field, field.minX + 92 * u, field.midY + 16 * u, font(46 * u, .medium))
}
// Where the next letter lands on the TV after `prefix`.
func tvLanding(_ s: NSRect, _ prefix: String, _ ch: String) -> NSPoint {
  let L = searchLayout(s)
  return NSPoint(x: L.textX + textWidth(prefix, L.font) + textWidth(ch, L.font) / 2, y: L.field.midY)
}

let thumbs: [(UInt32, UInt32)] = [(0x8A4B2C, 0x4A2416), (0x2F5A4A, 0x163027), (0x7A5A2E, 0x3E2C12), (0x3A4E78, 0x1B2540), (0x6E3B52, 0x341A28), (0x5A6B2E, 0x2C3614), (0x8A6A3A, 0x45321A), (0x34607A, 0x182F3E)]
func empanada(_ t: NSRect) {
  let cx = t.midX, base = t.midY + t.height * 0.2, rad = t.height * 0.34
  saved {
    color(0x000000, 0.25).setFill()
    NSBezierPath(ovalIn: NSRect(x: cx - rad * 1.08, y: base - rad * 0.06, width: rad * 2.16, height: rad * 0.22)).fill()
  }
  saved {
    NSBezierPath(rect: NSRect(x: t.minX, y: t.minY, width: t.width, height: base - t.minY)).addClip()
    NSGradient(starting: color(0xF2C46D), ending: color(0xC98A3A))!.draw(in: NSBezierPath(ovalIn: NSRect(x: cx - rad, y: base - rad, width: 2 * rad, height: 2 * rad)), angle: 90)
  }
  for i in 0...10 {
    let th = CGFloat.pi * CGFloat(i) / 10
    circle(NSPoint(x: cx + rad * 0.98 * cos(th), y: base - rad * 0.98 * sin(th)), rad * 0.075, color(0xB0742E))
  }
}
func tvSearch(_ s: NSRect, _ st: TVSearch) {
  let u = s.width / 1000
  let L = searchLayout(s)
  fill(L.field, 48 * u, color(0xFFFFFF, 0.07))
  ring(L.field, 48 * u, accent.withAlphaComponent(0.9), 3 * u)
  if st.flash > 0 { ring(L.field.insetBy(dx: -7 * u, dy: -7 * u), 55 * u, accent.withAlphaComponent(0.55 * st.flash), 7 * u) }
  let g = NSRect(x: L.field.minX + 36 * u, y: L.field.midY - 18 * u, width: 28 * u, height: 28 * u)
  color(0xC9D3E3).setStroke()
  let lens = NSBezierPath(ovalIn: g); lens.lineWidth = 5 * u; lens.stroke()
  let h = NSBezierPath(); h.move(to: NSPoint(x: g.maxX - 3 * u, y: g.maxY - 3 * u)); h.line(to: NSPoint(x: g.maxX + 9 * u, y: g.maxY + 9 * u))
  h.lineWidth = 6 * u; h.lineCapStyle = .round; h.stroke()
  var caretX = L.textX
  if st.typed.isEmpty { text("Buscar", L.font, color(0x6B7588), x: L.textX, baseline: L.baseline) }
  else { caretX += text(st.typed, L.font, color(0xFFFFFF, st.alpha), x: L.textX, baseline: L.baseline) }
  if st.caret { fill(NSRect(x: caretX + 4 * u, y: L.field.midY - 27 * u, width: 4 * u, height: 54 * u), 2 * u, accent) }

  let labelY = L.field.maxY + 58 * u
  text("Resultados", font(24 * u, .semibold), color(0xA9B3C4, st.results), x: s.minX + 70 * u, baseline: labelY)
  let gap = 26 * u, tw = (s.width - 140 * u - 3 * gap) / 4, th = tw * 0.5
  for row in 0..<2 {
    for col in 0..<4 {
      let idx = row * 4 + col
      let r = NSRect(x: s.minX + 70 * u + CGFloat(col) * (tw + gap), y: labelY + 26 * u + CGFloat(row) * (th + 66 * u), width: tw, height: th)
      fill(r, 14 * u, color(0xFFFFFF, 0.035))
      let a = clamp((st.results * 1.5 - CGFloat(idx) * 0.07) / 0.45)
      guard a > 0 else { continue }
      saved {
        cg.setAlpha(a)
        let t = r.offsetBy(dx: 0, dy: (1 - a) * 26 * u)
        saved {
          rr(t, 14 * u).addClip()
          let (c1, c2) = thumbs[idx % thumbs.count]
          NSGradient(starting: color(c1), ending: color(c2))!.draw(in: t, angle: 60)
          empanada(t)
        }
        fill(NSRect(x: t.minX, y: t.maxY + 14 * u, width: t.width * 0.78, height: 12 * u), 6 * u, color(0xFFFFFF, 0.28))
        fill(NSRect(x: t.minX, y: t.maxY + 34 * u, width: t.width * 0.48, height: 10 * u), 5 * u, color(0xFFFFFF, 0.14))
      }
    }
  }
}

// MARK: - Flying keys

func chip(_ c: NSPoint, _ ch: String, _ size: CGFloat, _ a: CGFloat, fillColor: NSColor = blue) {
  guard a > 0.01 else { return }
  saved {
    cg.setAlpha(a)
    let r = NSRect(x: c.x - size / 2, y: c.y - size / 2, width: size, height: size)
    shadowed(size * 0.6, -size * 0.12, fillColor.withAlphaComponent(0.6)) { fill(r, size * 0.24, fillColor) }
    NSGradient(starting: color(0xFFFFFF, 0.28), ending: color(0xFFFFFF, 0))!.draw(in: rr(r, size * 0.24), angle: 90)
    let f = font(size * 0.58, .semibold)
    let isLetter = ch.lowercased() == ch && ch.rangeOfCharacter(from: .letters) != nil
    centered(ch, f, .white, cx: c.x, baseline: c.y + (isLetter ? f.xHeight : f.capHeight) / 2)
  }
}
// bias moves the arc's control point along a→b: 0.5 is symmetric, >1 makes it land from above.
func arcPoint(_ a: NSPoint, _ b: NSPoint, _ t: CGFloat, lift: CGFloat, bias: CGFloat = 0.5) -> NSPoint {
  let ctrl = NSPoint(x: a.x + (b.x - a.x) * bias, y: min(a.y, b.y) - lift)
  let m = 1 - t
  return NSPoint(x: m * m * a.x + 2 * m * t * ctrl.x + t * t * b.x, y: m * m * a.y + 2 * m * t * ctrl.y + t * t * b.y)
}
func arcGuide(_ a: NSPoint, _ b: NSPoint, lift: CGFloat, width: CGFloat, alpha: CGFloat, col: NSColor = accent, bias: CGFloat = 0.5) {
  guard alpha > 0.01 else { return }
  let p = NSBezierPath()
  p.move(to: a)
  for i in 1...60 { p.line(to: arcPoint(a, b, CGFloat(i) / 60, lift: lift, bias: bias)) }
  saved { col.withAlphaComponent(0.10 * alpha).setStroke(); p.lineWidth = width * 7; p.lineCapStyle = .round; p.stroke() }
  let d = p.copy() as! NSBezierPath
  d.lineWidth = width; d.lineCapStyle = .round
  d.setLineDash([0.1, width * 4], count: 2, phase: 0)
  col.withAlphaComponent(0.55 * alpha).setStroke(); d.stroke()
}
// A key at progress p (0…1) of its trip from a to b, with a short trail.
func flight(_ a: NSPoint, _ b: NSPoint, _ ch: String, _ p: CGFloat, size0: CGFloat, size1: CGFloat, lift: CGFloat, fillColor: NSColor = blue, bias: CGFloat = 0.5) {
  guard p > 0, p < 1 else { return }
  var q = max(0, p - 0.22)
  while q < p {
    let k = (q - (p - 0.22)) / 0.22
    circle(arcPoint(a, b, ease(q), lift: lift, bias: bias), lerp(size0, size1, ease(q)) * 0.07 * (0.4 + k), fillColor.withAlphaComponent(0.55 * k))
    q += 0.02
  }
  let e = ease(p)
  let alpha = min(1, p / 0.08) * (p > 0.88 ? (1 - p) / 0.12 : 1)
  chip(arcPoint(a, b, e, lift: lift, bias: bias), ch, lerp(size0, size1, e), alpha, fillColor: fillColor)
}

// MARK: - Other props

func checkBadge(_ c: NSPoint, _ r: CGFloat) {
  shadowed(r * 0.6, -r * 0.15, color(0x000000, 0.4)) { circle(c, r, color(0x34C77B)) }
  let p = NSBezierPath()
  p.move(to: NSPoint(x: c.x - r * 0.42, y: c.y + r * 0.02)); p.line(to: NSPoint(x: c.x - r * 0.1, y: c.y + r * 0.32)); p.line(to: NSPoint(x: c.x + r * 0.45, y: c.y - r * 0.3))
  p.lineWidth = r * 0.2; p.lineCapStyle = .round; p.lineJoinStyle = .round; NSColor.white.setStroke(); p.stroke()
}
func crossBadge(_ c: NSPoint, _ r: CGFloat) {
  shadowed(r * 0.6, -r * 0.15, color(0x000000, 0.4)) { circle(c, r, color(0xE5484D)) }
  let p = NSBezierPath(), d = r * 0.36
  p.move(to: NSPoint(x: c.x - d, y: c.y - d)); p.line(to: NSPoint(x: c.x + d, y: c.y + d))
  p.move(to: NSPoint(x: c.x + d, y: c.y - d)); p.line(to: NSPoint(x: c.x - d, y: c.y + d))
  p.lineWidth = r * 0.2; p.lineCapStyle = .round; NSColor.white.setStroke(); p.stroke()
}
func triangle(_ c: NSPoint, _ s: CGFloat, dir: Int, _ col: NSColor) {
  // dir: 0 up, 1 right, 2 down, 3 left
  let pts: [NSPoint] = [NSPoint(x: 0, y: -1), NSPoint(x: 0.9, y: 0.6), NSPoint(x: -0.9, y: 0.6)]
  let ang = CGFloat(dir) * .pi / 2
  let p = NSBezierPath()
  for (i, q) in pts.enumerated() {
    let x = q.x * cos(ang) - q.y * sin(ang), y = q.x * sin(ang) + q.y * cos(ang)
    let pt = NSPoint(x: c.x + x * s, y: c.y + y * s)
    if i == 0 { p.move(to: pt) } else { p.line(to: pt) }
  }
  p.close(); col.setFill(); p.fill()
}
func remote(_ r: NSRect, lit: Int) {
  let u = r.width / 220
  shadowed(70 * u, -36 * u, color(0x000000, 0.6)) { fill(r, r.width / 2, color(0x222836)) }
  saved { rr(r, r.width / 2).addClip(); vgrad(r, color(0x2E3648), color(0x181D27)) }
  ring(r.insetBy(dx: 1.5 * u, dy: 1.5 * u), r.width / 2, color(0x46506A), 3 * u)
  fill(NSRect(x: r.midX - 22 * u, y: r.minY + 34 * u, width: 44 * u, height: 14 * u), 7 * u, color(0x0C0F15))
  let dc = NSPoint(x: r.midX, y: r.minY + 210 * u)
  circle(dc, 86 * u, color(0x3A4356))
  circle(dc, 40 * u, color(0x262C3A))
  for d in 0..<4 {
    let ang = CGFloat(d) * .pi / 2 - .pi / 2
    let c = NSPoint(x: dc.x + 63 * u * cos(ang), y: dc.y + 63 * u * sin(ang))
    if d == lit { glow(c, 50 * u, orange.withAlphaComponent(0.6)) }
    triangle(c, 11 * u, dir: d, d == lit ? orange : color(0xC9D3E3))
  }
  if lit == 4 { glow(dc, 80 * u, orange.withAlphaComponent(0.6)); circle(dc, 40 * u, orange) }
  for row in 0..<2 { for col in 0..<2 { circle(NSPoint(x: r.midX + (col == 0 ? -46 : 46) * u, y: r.minY + (370 + CGFloat(row) * 76) * u), 24 * u, color(0x343C4F)) } }
  fill(NSRect(x: r.midX - 27 * u, y: r.minY + 540 * u, width: 54 * u, height: 150 * u), 27 * u, color(0x343C4F))
}
func wifi(_ c: NSPoint, _ size: CGFloat, _ col: NSColor) {
  glow(c, size * 1.4, col.withAlphaComponent(0.25))
  circle(NSPoint(x: c.x, y: c.y), size * 0.1, col)
  for (i, r) in [0.38, 0.68, 0.98].enumerated() {
    let p = NSBezierPath()
    p.appendArc(withCenter: c, radius: size * CGFloat(r), startAngle: 225, endAngle: 315, clockwise: false)
    p.lineWidth = size * 0.13; p.lineCapStyle = .round
    col.withAlphaComponent(1 - CGFloat(i) * 0.12).setStroke(); p.stroke()
  }
}
func pill(_ s: String, _ f: NSFont, cx: CGFloat, cy: CGFloat, dot: NSColor) {
  let w = textWidth(s, f) + f.pointSize * 2.4, h = f.pointSize * 2
  let r = NSRect(x: cx - w / 2, y: cy - h / 2, width: w, height: h)
  fill(r, h / 2, color(0xFFFFFF, 0.07)); ring(r, h / 2, color(0xFFFFFF, 0.12), 2)
  circle(NSPoint(x: r.minX + f.pointSize * 0.95, y: cy), f.pointSize * 0.22, dot)
  text(s, f, ink, x: r.minX + f.pointSize * 1.6, baseline: cy + f.capHeight / 2)
}

// The TV's on-screen keyboard: what typing with the remote looks like.
func keyboardCard(_ r: NSRect) -> NSRect {
  shadowed(70, -36, color(0x000000, 0.55)) { fill(r, 36, color(0x131925)) }
  ring(r.insetBy(dx: 1.5, dy: 1.5), 35, color(0x2C3446), 3)
  let pad: CGFloat = 58
  let field = NSRect(x: r.minX + pad, y: r.minY + 44, width: r.width - 2 * pad, height: 78)
  fill(field, 39, color(0xFFFFFF, 0.06))
  let typedW = text("receta", font(40, .medium), ink, x: field.minX + 32, baseline: field.midY + 14)
  fill(NSRect(x: field.minX + 36 + typedW, y: field.midY - 24, width: 4, height: 48), 2, accent)
  let rows = ["abcdefg", "hijklmn", "ñopqrst", "uvwxyz⌫"].map { Array($0) }
  let key: CGFloat = 100, gap: CGFloat = 14, top = field.maxY + 34
  var centers: [Character: NSPoint] = [:]
  for (ri, row) in rows.enumerated() {
    for (ci, ch) in row.enumerated() {
      let k = NSRect(x: r.minX + pad + CGFloat(ci) * (key + gap), y: top + CGFloat(ri) * (key + gap), width: key, height: key)
      centers[ch] = NSPoint(x: k.midX, y: k.midY)
      fill(k, 16, color(0x222937))
    }
  }
  let word = Array("receta")
  for ch in Set(word) { if let c = centers[ch] { ring(NSRect(x: c.x - key / 2, y: c.y - key / 2, width: key, height: key).insetBy(dx: 2, dy: 2), 15, orange.withAlphaComponent(0.75), 4) } }
  let path = NSBezierPath()
  var cur = centers["a"]!
  path.move(to: cur)
  for ch in word {
    let n = centers[ch]!
    path.line(to: NSPoint(x: n.x, y: cur.y)); path.line(to: n); cur = n
  }
  saved { orange.withAlphaComponent(0.16).setStroke(); path.lineWidth = 26; path.lineJoinStyle = .round; path.stroke() }
  path.lineWidth = 6; path.lineCapStyle = .round; path.lineJoinStyle = .round
  path.setLineDash([16, 14], count: 2, phase: 0)
  orange.setStroke(); path.stroke()
  for (ri, row) in rows.enumerated() {
    for (ci, ch) in row.enumerated() {
      let c = NSPoint(x: r.minX + pad + CGFloat(ci) * (key + gap) + key / 2, y: top + CGFloat(ri) * (key + gap) + key / 2)
      let f = font(40, .medium)
      centered(String(ch), f, color(0xC9D3E3), cx: c.x, baseline: c.y + (ch == "⌫" ? f.capHeight : f.xHeight) / 2)
    }
  }
  return field
}

// MARK: - App Store / Play panorama

struct Board {
  let pw: CGFloat
  let n = 5
  let ph: CGFloat = 2868
  func c(_ i: Int) -> CGFloat { (CGFloat(i) + 0.5) * pw }
}

func panelTitle(_ B: Board, _ i: Int, _ title: String, _ sub: String) {
  let maxW = B.pw - 150
  var tf = font(112, .bold)
  let widest = title.split(separator: "\n").map { textWidth(String($0), tf, kern: -2.5) }.max()!
  if widest > maxW { tf = font(112 * maxW / widest, .bold) }
  paragraph(title, tf, ink, NSRect(x: B.c(i) - B.pw / 2, y: 196, width: B.pw, height: 300), lineHeight: tf.pointSize * 1.08, kern: -2.5)
  paragraph(sub, font(46, .regular), muted, NSRect(x: B.c(i) - B.pw / 2, y: 476, width: B.pw, height: 160), lineHeight: 62)
}

func ribbonY(_ x: CGFloat, _ B: Board) -> CGFloat { 2080 + 430 * sin(x / B.pw * .pi * 0.85 + 0.4) }
func ribbon(_ B: Board) {
  let w = B.pw * CGFloat(B.n)
  let p = NSBezierPath()
  var x: CGFloat = -40
  p.move(to: NSPoint(x: x, y: ribbonY(x, B)))
  while x < w + 40 { x += 16; p.line(to: NSPoint(x: x, y: ribbonY(x, B))) }
  saved { blue.withAlphaComponent(0.08).setStroke(); p.lineWidth = 150; p.stroke() }
  saved { blue.withAlphaComponent(0.12).setStroke(); p.lineWidth = 44; p.stroke() }
  let d = p.copy() as! NSBezierPath
  d.lineWidth = 7; d.lineCapStyle = .round; d.setLineDash([0.1, 26], count: 2, phase: 0)
  accent.withAlphaComponent(0.55).setStroke(); d.stroke()
}

func scene1(_ B: Board) {
  let tvR = NSRect(x: B.c(0) - 540, y: 860, width: 1560, height: 1560 * 0.585)
  let shown = "receta de empan"
  tv(tvR) { s in tvSearch(s, TVSearch(typed: shown, results: 1)) }
  let ps = phoneScreen(x: B.c(0) - 500, y: 1600, width: 560)
  phone(ps, "escribir")
  let k = ps.width / capW
  let cc = capCaret("receta de empanadas")
  let from = NSPoint(x: ps.minX + cc.x * k, y: ps.minY + cc.y * k)
  let s = tvScreen(tvR)
  let tail = Array("adas").map(String.init)
  arcGuide(from, tvLanding(s, shown, "a"), lift: 300, width: 7, alpha: 1, bias: 1.25)
  for (i, ch) in tail.enumerated().reversed() {
    flight(from, tvLanding(s, shown + tail[..<i].joined(), ch), ch, [0.72, 0.5, 0.3, 0.12][i], size0: 70, size1: 90, lift: 300, bias: 1.25)
  }
}

func scene2(_ B: Board) {
  let cx = B.c(1)
  let rem = NSRect(x: cx + 170, y: 930, width: 230, height: 860)
  // Arrow presses flying from the remote toward the TV (its right edge is in this panel).
  let tvRight = NSPoint(x: B.c(0) + 1000, y: 1330)
  let from = NSPoint(x: rem.midX, y: rem.minY + 40)
  arcGuide(from, tvRight, lift: 160, width: 6, alpha: 0.8, col: orange)
  remote(rem, lit: 1)
  for (ch, p) in [("→", 0.8), ("↓", 0.53), ("→", 0.27)] {
    flight(from, tvRight, ch, CGFloat(p), size0: 70, size1: 88, lift: 160, fillColor: color(0xE07A2E))
  }
  let card = NSRect(x: cx - 450, y: 1930, width: 900, height: 650)
  _ = keyboardCard(card)
  crossBadge(NSPoint(x: card.maxX - 20, y: card.minY + 20), 46)
  pill("«receta» con el control: 30 clics", font(40, .medium), cx: cx, cy: card.maxY + 100, dot: orange)
}

func scene3(_ B: Board) {
  let cx = B.c(2)
  let tw: CGFloat = min(520, (B.pw - 260) / 2), th = tw * 0.585
  let labels = ["Android TV\nGoogle TV", "Samsung", "LG", "Roku", "Sony", "Panasonic"]
  let hues: [(UInt32, UInt32)] = [(0x173A2E, 0x0A1712), (0x16264F, 0x0A1024), (0x3A1630, 0x170914), (0x2A1A4A, 0x110A20), (0x1E2A3A, 0x0B1018), (0x10304A, 0x07141F)]
  var rects: [NSRect] = []
  for i in 0..<6 {
    let col = i % 2, row = i / 2
    rects.append(NSRect(x: col == 0 ? cx - 40 - tw : cx + 40, y: 830 + CGFloat(row) * (th + 82), width: tw, height: th))
  }
  let ps = phoneScreen(x: cx - 240, y: 2160, width: 480)
  let hub = NSPoint(x: cx, y: ps.minY - 20)
  for r in rects {
    let end = NSPoint(x: r.midX, y: r.maxY + 40)
    let p = NSBezierPath()
    p.move(to: hub)
    p.curve(to: end, controlPoint1: NSPoint(x: hub.x, y: (hub.y + end.y) / 2), controlPoint2: NSPoint(x: end.x, y: (hub.y + end.y) / 2))
    saved { accent.withAlphaComponent(0.12).setStroke(); p.lineWidth = 22; p.stroke() }
    p.lineWidth = 5; p.lineCapStyle = .round; p.setLineDash([0.1, 18], count: 2, phase: 0)
    accent.withAlphaComponent(0.7).setStroke(); p.stroke()
  }
  for (i, r) in rects.enumerated() {
    tv(r) { s in
      vgrad(s, color(hues[i].0), color(hues[i].1))
      glow(NSPoint(x: s.midX, y: s.midY), s.width * 0.6, color(0xFFFFFF, 0.06))
      let lines = labels[i].split(separator: "\n").map(String.init)
      let f = font(lines.count > 1 ? s.width * 0.085 : s.width * 0.11, .bold)
      let lh = f.pointSize * 1.12
      let first = s.midY - lh * CGFloat(lines.count - 1) / 2
      for (j, l) in lines.enumerated() { centered(l, f, ink, cx: s.midX, baseline: first + CGFloat(j) * lh + f.capHeight / 2, kern: -0.5) }
    }
    checkBadge(NSPoint(x: r.maxX - 8, y: r.minY + 8), 30)
  }
  phone(ps, "escribir")
}

func allowDialog(_ s: NSRect) {
  let u = s.width / 1000
  for row in 0..<2 { for col in 0..<5 {
    fill(NSRect(x: s.minX + 60 * u + CGFloat(col) * 180 * u, y: s.minY + 110 * u + CGFloat(row) * 170 * u, width: 160 * u, height: 130 * u), 12 * u, color(0xFFFFFF, 0.06))
  } }
  fill(s, 0, color(0x000000, 0.45))
  let card = NSRect(x: s.midX - 330 * u, y: s.midY - 165 * u, width: 660 * u, height: 330 * u)
  shadowed(40 * u, -16 * u, color(0x000000, 0.5)) { fill(card, 28 * u, color(0x1F2636)) }
  ring(card, 28 * u, color(0x3A4458), 2 * u)
  centered("Teclado TV quiere conectarse", font(38 * u, .bold), ink, cx: card.midX, baseline: card.minY + 88 * u)
  centered("¿Permitís este dispositivo?", font(30 * u, .regular), muted, cx: card.midX, baseline: card.minY + 140 * u)
  let ok = NSRect(x: card.midX - 250 * u, y: card.maxY - 112 * u, width: 230 * u, height: 72 * u)
  let no = NSRect(x: card.midX + 20 * u, y: ok.minY, width: 230 * u, height: 72 * u)
  ring(ok.insetBy(dx: -7 * u, dy: -7 * u), 43 * u, accent.withAlphaComponent(0.7), 4 * u)
  fill(ok, 36 * u, ink)
  fill(no, 36 * u, color(0xFFFFFF, 0.08))
  centered("Permitir", font(30 * u, .semibold), color(0x0A0C10), cx: ok.midX, baseline: ok.midY + 11 * u)
  centered("Denegar", font(30 * u, .medium), color(0xC9D3E3), cx: no.midX, baseline: no.midY + 11 * u)
}

func scene4(_ B: Board) {
  let cx = B.c(3)
  let tvR = NSRect(x: cx - 420, y: 860, width: 1020, height: 1020 * 0.585)
  tv(tvR) { s in allowDialog(s) }
  let ps = phoneScreen(x: cx - 560, y: 1660, width: 600)
  let a = NSPoint(x: ps.maxX + 30, y: ps.minY + 260), b = NSPoint(x: tvR.midX + 140, y: tvR.maxY + 90)
  arcGuide(a, b, lift: -120, width: 7, alpha: 1)
  phone(ps, "permitir")
  wifi(arcPoint(a, b, 0.5, lift: -120), 120, accent)
}

func pinLayout(_ s: NSRect) -> [NSRect] {
  let u = s.width / 1000, bw = 112 * u, gap = 30 * u
  let x0 = s.midX - (4 * bw + 3 * gap) / 2
  return (0..<4).map { NSRect(x: x0 + CGFloat($0) * (bw + gap), y: s.minY + 268 * u, width: bw, height: 144 * u) }
}
func pinScreen(_ s: NSRect) {
  let u = s.width / 1000
  centered("Vincular con Teclado TV", font(40 * u, .bold), ink, cx: s.midX, baseline: s.minY + 150 * u)
  centered("Escribí este código en el celular", font(30 * u, .regular), muted, cx: s.midX, baseline: s.minY + 206 * u)
  for (i, r) in pinLayout(s).enumerated() {
    fill(r, 18 * u, color(0xFFFFFF, 0.08))
    let f = font(84 * u, .semibold)
    centered(["4", "8", "1", "7"][i], f, ink, cx: r.midX, baseline: r.midY + f.capHeight / 2)
  }
}

func scene5(_ B: Board) {
  let cx = B.c(4)
  let tvR = NSRect(x: cx - 600, y: 860, width: 1020, height: 1020 * 0.585)
  tv(tvR) { s in pinScreen(s) }
  let ps = phoneScreen(x: cx - 40, y: 1660, width: 600)
  phone(ps, "vincular")
  let k = ps.width / capW
  let boxes = pinLayout(tvScreen(tvR))
  let targets = [NSPoint(x: ps.minX + 602 * k, y: ps.minY + 865 * k), NSPoint(x: ps.minX + 846 * k, y: ps.minY + 865 * k)]
  for (j, p) in [(2, 0.86), (3, 0.3)].enumerated() {
    let from = NSPoint(x: boxes[p.0].midX, y: boxes[p.0].maxY + 30)
    if j == 0 { arcGuide(from, targets[0], lift: 0, width: 7, alpha: 1, bias: 1) }
    flight(from, targets[j], ["1", "7"][j], CGFloat(p.1), size0: 84, size1: 96, lift: 0, bias: 1)
  }
}

let panels = [
  ("1-escribir", "Escribí en la tele\ndesde el celular", "Búsquedas, usuarios y contraseñas\ncon el teclado de siempre."),
  ("2-sin-control", "Chau a escribir\ncon el control", "Nada de ir letra por letra\ncon las flechas."),
  ("3-marcas", "Para las teles\nmás comunes", "Android TV, Google TV, Samsung,\nLG, Roku, Sony y Panasonic."),
  ("4-conectar", "Se conecta\npor tu Wi-Fi", "La app encuentra tu tele. La primera\nvez la permitís con el control."),
  ("5-vincular", "Se vincula\nuna sola vez", "Sin cuentas ni publicidad.\nLo que escribís va solo a la tele."),
]

func panorama(_ B: Board) {
  let w = B.pw * CGFloat(B.n)
  vgrad(NSRect(x: 0, y: 0, width: w, height: B.ph), color(0x16264A), color(0x0A0C10))
  for (x, y, r) in [(B.c(0) + 260, 1300.0, 1000.0), (B.c(1) + 100, 2200, 800), (B.c(2), 1400, 950), (B.c(3) + 60, 1250, 850), (B.c(4) - 60, 1250, 850)] {
    glow(NSPoint(x: x, y: CGFloat(y)), CGFloat(r), blue.withAlphaComponent(0.2))
  }
  ribbon(B)
  for (i, p) in panels.enumerated() { panelTitle(B, i, p.1, p.2) }
  scene2(B); scene3(B); scene4(B); scene5(B); scene1(B)
}

func renderShots(previewDir: String?) {
  for (dir, outPW, outH) in [("store/screenshots/iphone-6.9", 1320, 2868), ("store/play", 1440, 2560)] {
    let scale = CGFloat(outH) / 2868
    let B = Board(pw: CGFloat(outPW) / scale)
    let ctx = makeContext(outPW * B.n, outH)
    drawInto(ctx, height: outH, scale: scale) { panorama(B) }
    let img = ctx.makeImage()!
    for (i, p) in panels.enumerated() { savePNG(img.cropping(to: CGRect(x: i * outPW, y: 0, width: outPW, height: outH))!, "\(dir)/\(p.0).png") }
    if let previewDir { savePNG(img, "\(previewDir)/panorama-\(outPW).png") }
  }
}

// MARK: - Header video

let phrase = Array("receta de empanadas")
let tStart = 0.8, tStep = 0.17, tFlight = 0.5, loopLength = 10.0
func charTime(_ i: Int) -> Double { tStart + Double(i) * tStep }
let enterAt = charTime(phrase.count - 1) + tFlight + 0.25
let resultsAt = enterAt + 0.3
// At the end everything is deleted from the phone, and the TV follows: the loop starts empty again.
let delStart = 8.3, delStep = 0.05, delLag = 0.08
let backspace = NSRect(x: 834, y: 1655, width: 108, height: 105)
func shownCount(_ t: Double, typeLag: Double, delLag: Double) -> Int {
  if t < delStart + delLag { return phrase.indices.filter { charTime($0) + typeLag <= t }.count }
  return max(0, phrase.count - Int((t - delStart - delLag) / delStep) - 1)
}

func headerScene(_ t: Double) {
  let W: CGFloat = 3840, H: CGFloat = 1646
  vgrad(NSRect(x: 0, y: 0, width: W, height: H), color(0x16264A), color(0x0A0C10))
  glow(NSPoint(x: 1800, y: 700), 1400, blue.withAlphaComponent(0.22))
  glow(NSPoint(x: 2700, y: 1100), 700, blue.withAlphaComponent(0.12))

  let phoneText = String(phrase[..<shownCount(t, typeLag: 0, delLag: 0)])
  let tvText = String(phrase[..<shownCount(t, typeLag: tFlight, delLag: delLag)])
  let delEnd = delStart + Double(phrase.count) * delStep
  let busy = (t >= tStart && t < enterAt) || (t >= delStart && t < delEnd + delLag)
  let caretOn = busy || t.truncatingRemainder(dividingBy: 1.0) < 0.55
  let results = clamp(CGFloat((t - resultsAt) / 1.0)) * (1 - clamp(CGFloat((t - delStart) / 0.45)))
  let flash = CGFloat(max(0, 1 - abs(t - (enterAt + 0.2)) / 0.35))

  let tvR = NSRect(x: 1000, y: 230, width: 1580, height: 1580 * 0.585)
  tv(tvR) { s in tvSearch(s, TVSearch(typed: tvText, caret: caretOn, results: results, flash: flash)) }

  var key: (NSRect, CGFloat)? = nil
  for i in phrase.indices where t >= charTime(i) && t < charTime(i) + 0.16 { key = keyRect(phrase[i]).map { ($0, CGFloat(1 - (t - charTime(i)) / 0.16)) } }
  if t >= delStart && t < delEnd { key = (backspace, CGFloat(1 - ((t - delStart) / delStep).truncatingRemainder(dividingBy: 1) * 0.6)) }
  let enter = t >= enterAt && t < enterAt + 0.3 ? CGFloat(1 - (t - enterAt) / 0.3) : 0
  let ps = phoneScreen(x: 2440, y: 470, width: 500)
  phone(ps, "escribir") { typingOverlay(Typing(text: phoneText, caret: caretOn, key: key, enter: enter)) }

  let k = ps.width / capW
  let s = tvScreen(tvR)
  let guide = CGFloat(clamp(CGFloat((t - tStart + 0.3) / 0.3)) * (1 - clamp(CGFloat((t - enterAt) / 0.4))))
  if guide > 0 {
    let a = capCaret(phoneText)
    arcGuide(NSPoint(x: ps.minX + a.x * k, y: ps.minY + a.y * k), tvLanding(s, tvText, "a"), lift: 190, width: 7, alpha: guide)
  }
  for i in phrase.indices where t > charTime(i) && t < charTime(i) + tFlight && phrase[i] != " " {
    let prefix = String(phrase[..<i])
    let a = capCaret(prefix + String(phrase[i]))
    let from = NSPoint(x: ps.minX + (a.x + 64) * k, y: ps.minY + (a.y - 8) * k)
    flight(from, tvLanding(s, prefix, String(phrase[i])), String(phrase[i]), CGFloat((t - charTime(i)) / tFlight), size0: 56, size1: 96, lift: 190)
  }
}

// MARK: - Search results video: typing with the remote, then with the phone

// 3:2 (Apple takes 1920x1280 to 3840x2560); 3600x2400 keeps H.264 at level 5.1. Shown small and muted
// in search results, so labels are big.
let cmpW = 3600, cmpH = 2400, cmpLength = 15.5
let cmpTV = NSRect(x: 280, y: 240, width: 2300, height: 2300 * 0.585)

// The TV's on-screen keyboard (7 columns, like many TV apps) and the remote's walk to type "receta".
let tvRows = ["abcdefg", "hijklmn", "ñopqrst", "uvwxyz⌫"].map { Array($0) }
func tvKeyPos(_ ch: Character) -> CGPoint {
  for (r, row) in tvRows.enumerated() { if let c = row.firstIndex(of: ch) { return CGPoint(x: c, y: r) } }
  return .zero
}
struct RemoteStep { let dir: Int; let from: CGPoint; let to: CGPoint; let letter: Character? }  // dir: 0 up, 1 right, 2 down, 3 left, 4 OK
let remoteSteps: [RemoteStep] = {
  var steps: [RemoteStep] = [], cur = CGPoint.zero
  for ch in "receta" {
    let target = tvKeyPos(ch)
    while cur.x != target.x { let n = CGPoint(x: cur.x + (target.x > cur.x ? 1 : -1), y: cur.y); steps.append(RemoteStep(dir: target.x > cur.x ? 1 : 3, from: cur, to: n, letter: nil)); cur = n }
    while cur.y != target.y { let n = CGPoint(x: cur.x, y: cur.y + (target.y > cur.y ? 1 : -1)); steps.append(RemoteStep(dir: target.y > cur.y ? 2 : 0, from: cur, to: n, letter: nil)); cur = n }
    steps.append(RemoteStep(dir: 4, from: cur, to: cur, letter: ch))
  }
  return steps
}()
let rStart = 0.6, rStep = 0.2
let swapAt = rStart + Double(remoteSteps.count) * rStep + 0.6, swapLength = 0.8
let pPhrase = Array("receta de empanadas"), pStart = swapAt + swapLength + 0.3, pStep = 0.12, pFlight = 0.45
func pTime(_ i: Int) -> Double { pStart + Double(i) * pStep }
let pEnter = pTime(pPhrase.count - 1) + pFlight + 0.25

func layer(_ a: CGFloat, _ f: () -> Void) {
  saved { cg.setAlpha(a); cg.beginTransparencyLayer(auxiliaryInfo: nil); f(); cg.endTransparencyLayer() }
}

func tvKeyboard(_ s: NSRect, typed: String, path: [CGPoint], press: CGFloat) {
  let u = s.width / 1000
  let L = searchLayout(s)
  fill(L.field, 48 * u, color(0xFFFFFF, 0.07))
  ring(L.field, 48 * u, accent.withAlphaComponent(0.9), 3 * u)
  var caretX = L.textX - 60 * u
  if typed.isEmpty { text("Buscar", L.font, color(0x6B7588), x: caretX, baseline: L.baseline) }
  else { caretX += text(typed, L.font, .white, x: caretX, baseline: L.baseline) }
  fill(NSRect(x: caretX + 4 * u, y: L.field.midY - 27 * u, width: 4 * u, height: 54 * u), 2 * u, accent)
  let key = 78 * u, gap = 12 * u
  let x0 = s.midX - (7 * key + 6 * gap) / 2, y0 = s.minY + 196 * u
  func center(_ p: CGPoint) -> NSPoint { NSPoint(x: x0 + p.x * (key + gap) + key / 2, y: y0 + p.y * (key + gap) + key / 2) }
  for (r, row) in tvRows.enumerated() { for c in row.indices { let k = center(CGPoint(x: c, y: r)); fill(NSRect(x: k.x - key / 2, y: k.y - key / 2, width: key, height: key), 12 * u, color(0x222937)) } }
  if path.count > 1 {
    let p = NSBezierPath(); p.move(to: center(path[0])); for q in path.dropFirst() { p.line(to: center(q)) }
    saved { orange.withAlphaComponent(0.18).setStroke(); p.lineWidth = 22 * u; p.lineJoinStyle = .round; p.lineCapStyle = .round; p.stroke() }
    p.lineWidth = 5 * u; p.lineJoinStyle = .round; p.lineCapStyle = .round; p.setLineDash([12 * u, 10 * u], count: 2, phase: 0)
    orange.setStroke(); p.stroke()
  }
  let cur = center(path.last ?? .zero)
  let cr = NSRect(x: cur.x - key / 2, y: cur.y - key / 2, width: key, height: key).insetBy(dx: -5 * u - 6 * u * press, dy: -5 * u - 6 * u * press)
  glow(cur, key * 1.1, (press > 0 ? orange : accent).withAlphaComponent(0.45))
  fill(cr, 14 * u, press > 0 ? orange : ink)
  let f = font(36 * u, .medium)
  for (r, row) in tvRows.enumerated() {
    for (c, ch) in row.enumerated() {
      let k = center(CGPoint(x: c, y: r))
      let under = hypot(k.x - cur.x, k.y - cur.y) < key * 0.5
      centered(String(ch), f, under ? color(0x0A0C10) : color(0xC9D3E3), cx: k.x, baseline: k.y + (ch == "⌫" ? f.capHeight : f.xHeight) / 2)
    }
  }
}

func compareScene(_ t: Double) {
  let W = CGFloat(cmpW), H = CGFloat(cmpH)
  vgrad(NSRect(x: 0, y: 0, width: W, height: H), color(0x16264A), color(0x0A0C10))
  glow(NSPoint(x: 1430, y: 930), 1900, blue.withAlphaComponent(0.22))
  glow(NSPoint(x: 3000, y: 1400), 1000, blue.withAlphaComponent(0.12))

  // The remote's walk.
  let rEnd = rStart + Double(remoteSteps.count) * rStep
  let k = t < rStart ? -1 : min(remoteSteps.count - 1, Int((t - rStart) / rStep))
  let q = k < 0 ? 0 : clamp(CGFloat((t - rStart - Double(k) * rStep) / 0.12))
  var path = [CGPoint.zero], typed = ""
  if k >= 0 {
    for i in 0...k {
      let st = remoteSteps[i]
      if st.dir == 4 { if i < k || q >= 1 { typed.append(st.letter!) } }
      else { let e = i < k ? 1 : ease(q); path.append(CGPoint(x: lerp(st.from.x, st.to.x, e), y: lerp(st.from.y, st.to.y, e))) }
    }
  }
  let clicks = k + 1
  let litNow = k >= 0 && t < rEnd && t - rStart - Double(k) * rStep < 0.14
  let lit = litNow ? remoteSteps[k].dir : -1
  let press: CGFloat = lit == 4 ? 1 - q * 0.5 : 0

  // The phone.
  // The remote's world fades out first, then the phone's fades in (no double exposure).
  let m = clamp(CGFloat((t - swapAt) / swapLength))
  let mOut = ease(clamp(m * 2)), mIn = ease(clamp(m * 2 - 1))
  let phoneText = String(pPhrase[..<pPhrase.indices.filter { pTime($0) <= t }.count])
  let tvText = String(pPhrase[..<pPhrase.indices.filter { pTime($0) + pFlight <= t }.count])
  let busy = (t >= rStart && t < rEnd) || (t >= pStart && t < pEnter)
  let caretOn = busy || t.truncatingRemainder(dividingBy: 1.0) < 0.55
  let results = clamp(CGFloat((t - pEnter - 0.3) / 1.0))
  let flash = CGFloat(max(0, 1 - abs(t - (pEnter + 0.2)) / 0.35))

  tv(cmpTV) { s in
    if mOut < 1 { layer(1 - mOut) { tvKeyboard(s, typed: typed, path: path, press: press) } }
    if mIn > 0 { layer(mIn) { tvSearch(s, TVSearch(typed: tvText, caret: caretOn, results: results, flash: flash)) } }
  }
  if mOut < 1 { layer(1 - mOut) { remote(NSRect(x: 2830, y: 640 + mOut * 600, width: 300, height: 1173), lit: lit) } }
  let ps = phoneScreen(x: 2700, y: 560 + (1 - mIn) * 600, width: 700)
  if mIn > 0 {
    var key: (NSRect, CGFloat)? = nil
    for i in pPhrase.indices where t >= pTime(i) && t < pTime(i) + 0.11 { key = keyRect(pPhrase[i]).map { ($0, CGFloat(1 - (t - pTime(i)) / 0.11)) } }
    let enter = t >= pEnter && t < pEnter + 0.3 ? CGFloat(1 - (t - pEnter) / 0.3) : 0
    layer(mIn) { phone(ps, "escribir") { typingOverlay(Typing(text: phoneText, caret: caretOn, key: key, enter: enter)) } }
  }
  let kk = ps.width / capW, z: CGFloat = 1.45
  let s = tvScreen(cmpTV)
  let guide = CGFloat(clamp(CGFloat((t - pStart + 0.3) / 0.3)) * (1 - clamp(CGFloat((t - pEnter) / 0.4))))
  if guide > 0 {
    let a = capCaret(phoneText)
    arcGuide(NSPoint(x: ps.minX + a.x * kk, y: ps.minY + a.y * kk), tvLanding(s, tvText, "a"), lift: 190 * z, width: 7 * z, alpha: guide)
  }
  for i in pPhrase.indices where t > pTime(i) && t < pTime(i) + pFlight && pPhrase[i] != " " {
    let prefix = String(pPhrase[..<i])
    let a = capCaret(prefix + String(pPhrase[i]))
    let from = NSPoint(x: ps.minX + (a.x + 64) * kk, y: ps.minY + (a.y - 8) * kk)
    flight(from, tvLanding(s, prefix, String(pPhrase[i])), String(pPhrase[i]), CGFloat((t - pTime(i)) / pFlight), size0: 56 * z, size1: 96 * z, lift: 190 * z)
  }

  let pf = font(118, .semibold), pillY: CGFloat = 1985
  if mOut < 1 { layer(1 - mOut) { pill("Con el control: \(max(0, clicks)) \(clicks == 1 ? "clic" : "clics")", pf, cx: cmpTV.midX, cy: pillY, dot: orange) } }
  if mIn > 0 { layer(mIn) { pill("Con el celular: escribís y listo", pf, cx: cmpTV.midX, cy: pillY, dot: accent) } }
}
// The last 0.8 s go back to the first frame through an empty TV, so the loop is seamless.
func compareBase() {
  vgrad(NSRect(x: 0, y: 0, width: CGFloat(cmpW), height: CGFloat(cmpH)), color(0x16264A), color(0x0A0C10))
  glow(NSPoint(x: 1430, y: 930), 1900, blue.withAlphaComponent(0.22))
  glow(NSPoint(x: 3000, y: 1400), 1000, blue.withAlphaComponent(0.12))
  tv(cmpTV) { _ in }
}
func compareFrame(_ t: Double) {
  let f = clamp(CGFloat((t - (cmpLength - 0.8)) / 0.8))
  if f <= 0 { compareScene(t) }
  else if f < 0.5 { compareScene(t); layer(ease(f * 2)) { compareBase() } }
  else { compareBase(); layer(ease(f * 2 - 1)) { compareScene(0) } }
}

func renderVideo(_ name: String, w: Int, h: Int, length: Double, still: Double, audio: Bool, previewDir: String?, scene: (Double) -> Void) {
  let fps = 30, out = "store/header/\(name)"
  try? FileManager.default.createDirectory(atPath: "store/header", withIntermediateDirectories: true)
  let stillCtx = makeContext(w, h)
  drawInto(stillCtx, height: h, scale: 1) { scene(still) }
  savePNG(stillCtx.makeImage()!, "\(out).png")

  let ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].first { FileManager.default.fileExists(atPath: $0) }!
  let p = Process()
  p.executableURL = URL(fileURLWithPath: ffmpeg)
  var a = ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "\(w)x\(h)", "-r", "\(fps)", "-i", "-"]
  // The header keeps a silent stereo track; Apple does not require audio.
  if audio { a += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-map", "0:v", "-map", "1:a", "-shortest", "-c:a", "aac", "-b:a", "128k"] }
  a += ["-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "5.1",
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-movflags", "+faststart", "\(out).mp4"]
  p.arguments = a
  let pipe = Pipe()
  p.standardInput = pipe
  try! p.run()
  let ctx = makeContext(w, h)
  let frames = Int((length * Double(fps)).rounded())
  for f in 0..<frames {
    drawInto(ctx, height: h, scale: 1) { scene(Double(f) / Double(fps)) }
    pipe.fileHandleForWriting.write(Data(bytes: ctx.data!, count: w * h * 4))
    if let previewDir, f % 15 == 0 { savePNG(ctx.makeImage()!, "\(previewDir)/\(name)-\(f).png") }
  }
  try! pipe.fileHandleForWriting.close()
  p.waitUntilExit()
  print("wrote \(out).mp4 (\(frames) frames)")
}

// Play feature graphic: the header's finished scene, cropped to 1024x500.
func renderFeature() {
  let scale: CGFloat = 500 / 1646
  let ctx = makeContext(1024, 500)
  drawInto(ctx, height: 500, scale: scale, offsetX: -(3840 * scale - 1024) / 2) { headerScene(6.5) }
  savePNG(ctx.makeImage()!, "store/play/feature-graphic.png")
}

let args = CommandLine.arguments.dropFirst()
let what = args.first ?? "all"
let previewDir = args.count > 1 ? args[args.startIndex + 1] : nil
if what == "shots" || what == "all" { renderShots(previewDir: previewDir) }
if what == "feature" || what == "all" { renderFeature() }
if what == "header" || what == "all" { renderVideo("header", w: 3840, h: 1646, length: loopLength, still: 6.5, audio: true, previewDir: previewDir, scene: headerScene) }
if what == "search" || what == "all" { renderVideo("search-results", w: cmpW, h: cmpH, length: cmpLength, still: 13, audio: false, previewDir: previewDir, scene: compareFrame) }
