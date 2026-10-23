import Cocoa

// Icone provider per gli header del menu: tile bianca arrotondata con il
// glyph del brand (assets/<slug>.png, 72px). Se l'asset manca, tile con
// l'iniziale: mai un buco. Stesso file usato dall'app e dal test visivo.

private let assetForProvider = [
    "claude": "anthropic",
    "codex": "openai",
    "muse": "meta",
]

private let fallbackForProvider: [String: (String, NSColor)] = [
    "claude": ("A", NSColor(red: 0xD9 / 255, green: 0x77 / 255, blue: 0x57 / 255, alpha: 1)),
    "codex": ("O", .black),
    "muse": ("M", NSColor(red: 0x00 / 255, green: 0x82 / 255, blue: 0xFB / 255, alpha: 1)),
    "openrouter": ("O", .black),
    "elevenlabs": ("E", .black),
]

func assetsDir() -> URL {
    URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
        .appendingPathComponent("assets")
}

// Mini-logo per la barra: solo glyph nel colore brand, niente tile bianca.
// Gli asset sono glyph scuri su fondo bianco opaco: maschera da luminanza
// invertita (bianco = trasparente), riempimento brand. Su barra scura il
// nero non si vedrebbe: codex bianco, muse azzurro schiarito.
private let barColorForProvider: [String: NSColor] = [
    "claude": NSColor(red: 0xD9 / 255, green: 0x77 / 255, blue: 0x57 / 255, alpha: 1),
    "codex": .white,
    "muse": NSColor(red: 0x4D / 255, green: 0xA3 / 255, blue: 0xFF / 255, alpha: 1),
]

// Icone e PNG sorgente in memoria: la barra si ridisegna a ogni aggiornamento e rileggere e decomprimere i PNG
// da disco ogni volta era la voce più cara della CPU della tray (campione del 22/10: open, read, inflate in draw).
private var barIconCache: [String: NSImage] = [:]
private var assetCache: [String: NSImage] = [:]
private func asset(_ name: String) -> NSImage? {
    if let img = assetCache[name] { return img }
    let img = NSImage(contentsOf: assetsDir().appendingPathComponent(name))
    if let img { assetCache[name] = img }
    return img
}

func barIcon(_ providerId: String, sizePt: CGFloat) -> NSImage {
    let key = "\(providerId)|\(sizePt)"
    if let hit = barIconCache[key] { return hit }
    let img = renderBarIcon(providerId, sizePt: sizePt)
    barIconCache[key] = img
    return img
}

private func renderBarIcon(_ providerId: String, sizePt: CGFloat) -> NSImage {
    let img = NSImage(size: NSSize(width: sizePt, height: sizePt))
    guard let slug = assetForProvider[providerId] else { return img }
    // via preferita: PNG normalizzati (inchiostro centrato, fondo trasparente)
    let pngURL = assetsDir().appendingPathComponent("bar-\(slug).png")
    if let png = NSImage(contentsOf: pngURL) {
        img.lockFocus()
        NSGraphicsContext.current?.imageInterpolation = .high
        png.draw(in: NSRect(x: 0, y: 0, width: sizePt, height: sizePt))
        img.unlockFocus()
        return img
    }
    // seconda: SVG simple-icons a sfondo trasparente (bar-<slug>.svg)
    let svgURL = assetsDir().appendingPathComponent("bar-\(slug).svg")
    if let svg = NSImage(contentsOf: svgURL) {
        img.lockFocus()
        NSGraphicsContext.current?.imageInterpolation = .high
        svg.draw(in: NSRect(x: 0, y: 0, width: sizePt, height: sizePt))
        img.unlockFocus()
        return img
    }
    // fallback: glyph dal PNG a fondo bianco (openai non è più su simple-icons)
    let url = assetsDir().appendingPathComponent("\(slug).png")
    guard let src = NSImage(contentsOf: url),
          let cg = src.cgImage(forProposedRect: nil, context: nil, hints: nil)
    else { return img }
    let w = cg.width, h = cg.height
    guard let gray = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8,
                               bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(),
                               bitmapInfo: CGImageAlphaInfo.none.rawValue),
          let raw = gray.data
    else { return img }
    // flip: senza, la maschera esce specchiata in verticale
    gray.translateBy(x: 0, y: CGFloat(h))
    gray.scaleBy(x: 1, y: -1)
    gray.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    let px = raw.bindMemory(to: UInt8.self, capacity: w * h)
    for i in 0 ..< w * h { px[i] = 255 - px[i] }
    guard let inv = gray.makeImage(),
          let prov = inv.dataProvider,
          let mask = CGImage(maskWidth: w, height: h, bitsPerComponent: 8, bitsPerPixel: 8,
                             bytesPerRow: w, provider: prov,
                             decode: nil, shouldInterpolate: true)
    else { return img }
    img.lockFocus()
    NSGraphicsContext.current?.imageInterpolation = .high
    if let ctx = NSGraphicsContext.current?.cgContext {
        let r = CGRect(x: 0, y: 0, width: sizePt, height: sizePt)
        ctx.saveGState()
        ctx.clip(to: r, mask: mask)
        (barColorForProvider[providerId] ?? .white).setFill()
        ctx.fill(r)
        ctx.restoreGState()
    }
    img.unlockFocus()
    return img
}

func providerIcon(_ providerId: String, sizePt: CGFloat = 18) -> NSImage {
    let img = NSImage(size: NSSize(width: sizePt, height: sizePt))
    img.lockFocus()
    NSGraphicsContext.current?.imageInterpolation = .high
    // tile (i glyph rasterizzati hanno fondo bianco: tinta piena, niente cuciture)
    NSColor.white.setFill()
    NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: sizePt, height: sizePt),
                 xRadius: sizePt * 0.28, yRadius: sizePt * 0.28).fill()
    let inset = sizePt * 0.2
    let inner = NSRect(x: inset, y: inset, width: sizePt - inset * 2, height: sizePt - inset * 2)
    var drawn = false
    if let slug = assetForProvider[providerId] {
        if let glyph = asset("\(slug).png") {
            glyph.draw(in: inner)
            drawn = true
        }
    }
    if !drawn {
        // fallback: iniziale sul colore del brand
        let (letter, color) = fallbackForProvider[providerId] ?? ("?", .systemGray)
        (letter as NSString).draw(in: inner, withAttributes: [
            .font: NSFont.systemFont(ofSize: sizePt * 0.62, weight: .bold),
            .foregroundColor: color,
            .paragraphStyle: {
                let p = NSMutableParagraphStyle()
                p.alignment = .center
                return p
            }(),
        ])
    }
    img.unlockFocus()
    return img
}

// Logo del provider per le righe del menu: glyph bar-<slug>.png (fondo trasparente) colorato
// al momento del disegno, così segue chiaro/scuro. OpenAI non ha colore: prende labelColor
// (nero in chiaro, bianco in scuro) invece del bianco fisso della barra.
private let menuColorForProvider: [String: NSColor] = [
    "claude": NSColor(red: 0xD9 / 255, green: 0x77 / 255, blue: 0x57 / 255, alpha: 1),
    "codex": .labelColor,
    "muse": NSColor(name: nil) { ap in
        ap.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(red: 0x4D / 255, green: 0xA3 / 255, blue: 0xFF / 255, alpha: 1)
            : NSColor(red: 0x00 / 255, green: 0x82 / 255, blue: 0xFB / 255, alpha: 1)
    },
]

func brandGlyph(_ providerId: String, pt: CGFloat) -> NSImage? {
    guard let slug = assetForProvider[providerId],
          let png = asset("bar-\(slug).png")
    else { return nil }
    let color = menuColorForProvider[providerId] ?? .labelColor
    return NSImage(size: NSSize(width: pt, height: pt), flipped: false) { r in
        NSGraphicsContext.current?.imageInterpolation = .high
        png.draw(in: r)
        color.set()
        r.fill(using: .sourceAtop)
        return true
    }
}
