import Cocoa
import CoreText

// MARK: - Models (specchia GET :3360/api/overview, hub)

struct Overview: Codable {
    let providers: [Provider]
    let renewals: [Renewal]
    let credit: CloudCredit?
    let credits: [String: CloudCredit]?
}

// Modello con una quota settimanale sua (limits di /api/oauth/usage, via credito-cloud): oggi è così che compare un modello nuovo
struct ModelLimit: Codable { let name: String; let pct: Double?; let resets: String? }
struct CloudCredit: Codable {
    let models: [ModelLimit]?
    let remaining: Double?
    let limit: Double?
    let used: Double?
    let renewsAt: String?
    let account: String?
    let unavailable: Bool?
    let nobonus: Bool?
    let stale: Bool?
    let asOf: Int?
    let reason: String?
}

// Età di un dato stantio: "dato di 5m fa", "dato di 2h fa" (stessa dicitura
// del dato vecchio di Muse lato server). Mai il futuro (orologi storti).
func staleAge(_ asOf: Int, now: Date = Date()) -> String {
    let mins = max(0, Int(now.timeIntervalSince1970) - asOf) / 60
    return mins < 60 ? "dato di \(mins)m fa" : "dato di \(mins / 60)h fa"
}

struct Provider: Codable {
    let id: String
    let name: String
    let error: String?
    let accounts: [Account]?
    let menuOnly: Bool?
    let billing: String?
}

struct Account: Codable {
    let id: String
    let label: String
    let code: String
    let active: Bool
    let status: String
    let quotas: [Quota]
    // Reset manuali disponibili: nil = ignoti (Claude, promo senza API),
    // mai zero inventato. Il server vecchio non la manda: resta nil.
    let resetCredits: ResetCredits?
    // Speso API Anthropic dell'org di questo account (solo l'account proprietario):
    // riga a consumo sotto le quote, mai in barra. Nil = sonda giù.
    let apiSpend: Quota?
}

// available fa fede (la lista può essere cappata); solo gli available.
struct ResetCredits: Codable {
    let available: Int
    let credits: [ResetCredit]?
}

struct ResetCredit: Codable {
    let title: String?
    let expiresAt: Int?
}

struct Quota: Codable {
    let key: String
    let usedPct: Int
    let resetsAt: Int?
    let resetText: String
    let status: String
    let detail: String?
    // Testo lungo per il tooltip (es. credito API: speso su concesso e ora
    // di lettura). Il server vecchio non la manda: resta nil.
    let note: String?
    // Andamento della % nel tempo (log del server + vdm per Claude):
    // sparkline nel menu. Il server vecchio non la manda: resta nil.
    let history: [HistoryPoint]?
}

// t epoch secondi, v = % usata (decimale da vdm, intera dal log).
struct HistoryPoint: Codable {
    let t: Int
    let v: Double
}

struct Renewal: Codable {
    let service: String
    let account: String
    let amount: String
    let cycle: String
    let renewsAt: String?
    let note: String
    let provider: String?
    let tray: Bool?
}

// Ritmo settimanale totale (18/10): somma delle % usate contro somma delle % di settimana
// trascorse, sugli account con quota 7D ancora viva (gli esauriti a parte). 1,00× = in linea.
// Progetti della settimana dall'hub (:3360/api/live, ricalcolati in background ogni 5 min, zero token).
struct LiveProject: Codable { let name: String; let claude: Double; let codex: Double; let muse: Double; let total: Double; let budgetPct: Double?; let priority: String; let label: String?; let title: String?; let what: String?; let state: String?; let why: String?
    let agents: AgentSummary?; let lastSeen: LastSeen?; let lastJob: LastJob?; let dead: Bool?; let dirMissing: Bool?; let topics: [TopicsChat]?
    let dir: String?; let members: [String]?; let subgroups: [SubGroup]? }
struct LastSeen: Codable { let at: Double; let provider: String }
struct TopicsChat: Codable { let title: String; let busy: Bool; let url: String }
struct AgentOpen: Codable { let url: String; let via: String }
struct AgentInfo: Codable { let kind: String; let provider: String; let model: String; let title: String; let startedAt: Double; let lastActivity: Double; let open: AgentOpen?; let `where`: String?; let res: AgentRes?
    let depth: Int?; let use: AgentUse? }
// Consumo della sessione dall'hub: token nuovi del giro attuale e dell'ultima ora; per Claude anche la % della settimana.
struct AgentUse: Codable { let tokens: Double; let hourTokens: Double; let pct: Double?; let hourPct: Double? }
func tokText(_ t: Double) -> String { t >= 1_000_000 ? String(format: "%.1f M", t / 1_000_000).replacingOccurrences(of: ".", with: ",") : t >= 1000 ? "\(Int((t / 1000).rounded())) k" : "\(Int(t))" }
struct SubGroup: Codable { let path: String; let members: [String]; let agents: Int; let claude: Double; let codex: Double; let muse: Double }
struct AgentRes: Codable { let cpu: Double; let memMB: Double; let shared: Int? }
struct AgentModelCount: Codable { let provider: String; let model: String; let n: Int }
struct AgentSummary: Codable { let count: Int; let models: [AgentModelCount]; let opus: Int; let opusMs: Double; let list: [AgentInfo] }
struct LastJob: Codable { let task: String; let status: String; let endedAt: Double? }
struct LiveResp: Codable { let at: Double; let projects: [LiveProject] }
var liveProjects: [LiveProject] = []
// USAGE_HUB_URL solo per lo snapshot con dati finti (per esempio Muse senza quota): la tray vera parla sempre a :3360.
let hubURL = ProcessInfo.processInfo.environment["USAGE_HUB_URL"] ?? "http://127.0.0.1:3360"
// Decisioni del gate per classe e freno davanti a museagent/codexagent (:3360/api/gates).
struct GateResult: Codable { let go: Bool; let provider: String?; let account: String?; let reason: String; let waitUntil: Double? }
struct ClassGate: Codable {
    let order: [String]; let result: GateResult
    enum K: String, CodingKey { case order }
    init(from d: Decoder) throws { order = try d.container(keyedBy: K.self).decode([String].self, forKey: .order); result = try GateResult(from: d) }
    func encode(to e: Encoder) throws {}
}
struct AccountWait: Codable { let provider: String; let account: String; let kind: String?; let why: String; let until: Double?; let target: Double? }
struct ProviderState: Codable { let state: String; let reason: String; let waitUntil: Double?; let accounts: [AccountWait]? }
struct OverrideInfo: Codable { let provider: String; let hold: Bool?; let until: Double; let reason: String? }
struct GatesResp: Codable { let classes: [String: ClassGate]; let brakes: [String: GateResult]; let providers: [String: ProviderState]?; let overrides: [OverrideInfo]?; let reserve: Int }
var liveGates: GatesResp?
struct QueueItem: Codable { let id: String; let task: String; let project: String; let status: String; let waitUntil: Double?; let provider: String? }
struct QueueResp: Codable { let items: [QueueItem] }
struct HeavyOver: Codable { let provider: String; let account: String; let last24h: Double; let perDay: Double }
struct HeavyToday: Codable { let provider: String; let account: String; let last24h: Double; let perDay: Double; let used: Double }
struct HeavySession: Codable { let project: String; let sessions: Int; let tokens: Double }
struct HeavyResp: Codable { let over: [HeavyOver]; let today: [HeavyToday]; let sessions: [HeavySession] }
var liveQueue: [QueueItem] = []
var liveHeavy: HeavyResp?
struct MacHog: Codable { let name: String; let memMB: Double; let cpu: Double; let n: Int }
struct MacTree: Codable { let kind: String; let project: String; let cpu: Double; let memMB: Double; let memReal: Bool }
struct MacPaused: Codable { let project: String; let kind: String; let label: String; let since: Double; let reason: String }
struct EffortPart: Codable { let key: String; let name: String; let pct: Int?; let level: Int; let load: Double?; let byLoad: Bool? }
struct Effort: Codable { let level: Int; let label: String; let driver: String; let why: String; let score: Int; let parts: [EffortPart] }
struct MacResp: Codable {
    let effort: Effort?
    let cores: Int; let loadPerCore: Double; let maxLoadPerCore: Double
    let swapUsedGB: Double?; let swapTotalGB: Double?; let swapSustained: Bool
    let strained: Bool; let reason: String; let hogs: [MacHog]; let trees: [MacTree]; let paused: [MacPaused]; let note: String
    let history: [String: [HistoryPoint]]?
    let mem: MacMem?; let disk: MacDisk?
}
struct MacMem: Codable { let totalGB: Double; let usedGB: Double; let appGB: Double; let wiredGB: Double; let compressedGB: Double; let cachedGB: Double; let freeGB: Double }
struct MacDisk: Codable { let freeGB: Double; let totalGB: Double }
func gbNum(_ g: Double) -> String { (g >= 100 ? String(format: "%.0f GB", g) : String(format: "%.1f GB", g)).replacingOccurrences(of: ".", with: ",") }
var liveMac: MacResp?
// Attendibilità dei processi (hub, src/trust.mjs): solo i sospetti, con i motivi. Per pid, così le righe dei processi li trovano.
struct TrustItem: Codable { let pid: Int32; let name: String; let path: String; let level: String; let reasons: [String]; let signer: String? }
struct TrustResp: Codable { let counts: [String: Int]; let items: [TrustItem] }
var liveTrust: TrustResp?
func trustOf(_ pids: [pid_t]) -> [TrustItem] { (liveTrust?.items ?? []).filter { pids.contains($0.pid) } }
// PC di casa (hub /api/pc, da ~/bin/pc-state): dorme, acceso o lavora. avviso = Mac sopra la soglia
// di offload e PC che dorme, cioè il lavoro pesante sta girando qui invece che là.
// Una macchina, dall'hub (/api/machines): questo Mac, il PC, domani altre. Tutte la stessa card: niente nomi nel codice.
struct MachineMetric: Codable { let key: String; let name: String; let pct: Int; let level: Int; let limit: Double?; let note: String; let history: [HistoryPoint]? }
struct Machine: Codable { let id: String; let name: String; let local: Bool; let state: String; let level: Int; let caption: String?; let lines: [String]; let metrics: [MachineMetric]; let foot: String?; let offload: Int? }
// Un'altra macchina sta facendo girare lavori nostri (offload): la barra lo segna, sennò resta com'è.
func remoteOffload() -> Bool { liveMachines?.contains { !$0.local && ($0.offload ?? 0) > 0 } ?? false }
var liveMachines: [Machine]?
var snapshotMode = false
struct PcResp: Codable { let pc: String; let perche: String?; let mac: Double?; let soglia: Double?; let avviso: Bool }
var livePc: PcResp?
// Automazioni dell'hub (:3360/api/automations/summary): chi ti aspetta, cosa è rotto, se le fonti rispondono.
struct AutoSource: Codable { let name: String; let ok: Bool; let at: Double?; let pending: Bool? }
struct AutoSummary: Codable { let needsYou: Int; let broken: Int; let ok: Int; let hidden: Int; let runsToday: Int; let checkedAt: Double; let sources: [AutoSource] }
var liveAuto: AutoSummary?
// Ultima lettura buona: oltre 10 minuti il dato sparisce (stessa convenzione dell'overview: meglio niente che un numero vecchio).
var liveAutoAt: Date?
let livePaths: [(String, Double)] = [("/api/live", 10.0), ("/api/gates", 25.0), ("/api/queue", 10.0), ("/api/heavy", 25.0), ("/api/mac", 25.0), ("/api/mac/trust", 25.0), ("/api/pc", 15.0), ("/api/machines", 25.0), ("/api/automations/summary", 25.0)]
// Una risposta del hub nello stato globale giusto; usata da fetchLive e dallo snapshot.
func applyLive(_ path: String, _ data: Data?) {
    guard let d = data else { return }
    switch path {
    case "/api/live": if let r = try? JSONDecoder().decode(LiveResp.self, from: d) { liveProjects = r.projects }
    case "/api/gates": if let g = try? JSONDecoder().decode(GatesResp.self, from: d) { liveGates = g }
    case "/api/queue": if let q = try? JSONDecoder().decode(QueueResp.self, from: d) { liveQueue = q.items }
    case "/api/mac": if let m = try? JSONDecoder().decode(MacResp.self, from: d) { liveMac = m }
    case "/api/mac/trust": if let t = try? JSONDecoder().decode(TrustResp.self, from: d) { liveTrust = t }
    case "/api/heavy": if let h = try? JSONDecoder().decode(HeavyResp.self, from: d) { liveHeavy = h }
    case "/api/pc": if let p = try? JSONDecoder().decode(PcResp.self, from: d) { livePc = p }
    case "/api/machines": if let m = try? JSONDecoder().decode([Machine].self, from: d) { liveMachines = m }
    case "/api/automations/summary": if let a = try? JSONDecoder().decode(AutoSummary.self, from: d) { liveAuto = a; liveAutoAt = Date() }
    default: break
    }
}
func fetchLive(_ done: @escaping () -> Void) {
    let group = DispatchGroup()
    var results: [String: Data] = [:]
    let lock = NSLock()
    for (path, timeout) in livePaths {
        guard let url = URL(string: hubURL + path) else { continue }
        var req = URLRequest(url: url); req.timeoutInterval = timeout
        group.enter()
        URLSession.shared.dataTask(with: req) { data, _, _ in
            if let d = data { lock.lock(); results[path] = d; lock.unlock() }
            group.leave()
        }.resume()
    }
    group.notify(queue: .main) {
        for (path, d) in results { applyLive(path, d) }
        // Senza una lettura buona il dato invecchia: oltre 10 minuti sparisce, come l'overview.
        if let at = liveAutoAt, Date().timeIntervalSince(at) > 600 { liveAuto = nil; liveAutoAt = nil }
        done()
    }
}
func pctShort(_ v: Double) -> String { v == 0 ? "–" : String(format: v >= 10 ? "%.0f%%" : "%.1f%%", v).replacingOccurrences(of: ".", with: ",") }

struct PaceRow { let label: String; let provider: String; let used: Int; let expected: Int }
func paceSummary(_ snap: Overview?, now: Date = Date()) -> (ratio: Double, used: Int, expected: Int, rows: [PaceRow])? {
    var rows: [PaceRow] = []
    for p in snap?.providers ?? [] {
        for a in p.accounts ?? [] {
            guard let w = a.quotas.first(where: { $0.key.lowercased() == "7d" }), let r = w.resetsAt else { continue }
            // Esaurito: il suo consumo è passato e non si frena più; terrebbe la cella rossa fino al reset.
            if w.usedPct >= 100 { continue }
            let left = Double(r) - now.timeIntervalSince1970
            let elapsed = min(max(1 - left / (7 * 86400), 0), 1)
            rows.append(PaceRow(label: a.label, provider: p.id, used: w.usedPct, expected: Int((elapsed * 100).rounded())))
        }
    }
    let u = rows.reduce(0) { $0 + $1.used }, e = rows.reduce(0) { $0 + $1.expected }
    // Sotto il 5% di previsto totale il rapporto non dice niente (inizio settimana per tutti).
    guard e >= 5 else { return nil }
    return (Double(u) / Double(e), u, e, rows)
}
func paceStatus(_ ratio: Double) -> String { ratio <= 1.0 ? "ok" : ratio <= 1.3 ? "warning" : "critical" }
func paceText(_ ratio: Double) -> String { String(format: "%.2f×", ratio).replacingOccurrences(of: ".", with: ",") }

func statusColor(_ s: String) -> NSColor {
    switch s {
    case "ok": return NSColor(red: 0x30 / 255, green: 0xD1 / 255, blue: 0x58 / 255, alpha: 1)
    case "warning": return .systemOrange
    case "critical", "depleted": return .systemRed
    default: return .secondaryLabelColor
    }
}

// Testo con baseline ESATTA: NSString.draw(at:) sposta tutto di ~+2.4pt
// rispetto alla y data (misurato sull'inchiostro il 2026-10-07), rendendo
// inutile qualsiasi centratura calcolata. CoreText no: textPosition = baseline.
func drawBaseline(_ s: String, x: CGFloat, baseline y: CGFloat,
                  font: NSFont, color: NSColor, shadow: Bool = false) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    let line = CTLineCreateWithAttributedString(
        NSAttributedString(string: s, attributes: [.font: font,
                                                   .foregroundColor: color]))
    ctx.saveGState()
    if shadow {
        ctx.setShadow(offset: CGSize(width: 0, height: -0.5), blur: 1,
                      color: NSColor.black.withAlphaComponent(0.75).cgColor)
    }
    ctx.textPosition = CGPoint(x: x, y: y)
    CTLineDraw(line, ctx)
    ctx.restoreGState()
}

// MARK: - Menubar view: una colonna per account, quote impilate
//
// Header con mini-logo del provider + email, sotto le quote in colonna
// (5h sopra, 7d sotto): tag finestra, barra (= quota usata), %, reset.
// Tutti i testi bianchi, sempre: i grigi su questa barra non si leggono.

// Nella barra lo spazio accanto al notch è poco: un dato vecchio dice solo l'età («1h fa», in grigio), la frase intera sta nel menu.
func barTime(_ q: Quota) -> String { q.status == "stale" ? q.resetText.replacingOccurrences(of: "dato di ", with: "") : q.resetText }
class UsageBarView: NSView {
    // La barra dei menu di macOS è vetro: una vista dentro il pulsante viene fusa con lo sfondo e i colori escono
    // grigi (verde, arancio e bianco spenti, 22/10). Fuori dalla vibrancy i colori sono quelli disegnati.
    var snapshot: Overview? { didSet { cachedLayout = nil } }
    var isOffline = false { didSet { cachedLayout = nil } }
    // Misure del testo calcolate una volta per dato nuovo: la barra si ridisegna anche quando i dati non cambiano
    // (altre icone, tema, spazi) e rimisurare ogni stringa a ogni disegno era il resto della CPU della tray.
    private var cachedLayout: (groups: [GroupFrame], width: CGFloat, macW: CGFloat)?
    func invalidate() { cachedLayout = nil; needsDisplay = true }

    // Tre righe intere: mail 7pt + 5H + 7D. Icona 8px a x0 come le righe
    // (15..23, cima flush col top caps), mail rientrata dopo l'icona.
    // Tag maiuscoli 7pt (top 13.5): i gambetti di h/d toccherebbero l'icona.
    private let headerFont = NSFont.systemFont(ofSize: 7, weight: .semibold)
    private let headerBaseline: CGFloat = 17
    private let iconSize: CGFloat = 8
    private let iconY: CGFloat = 15
    private let iconIndent: CGFloat = 11
    private let tagFont = NSFont.monospacedSystemFont(ofSize: 7, weight: .semibold)
    private let tagBaselineShift: CGFloat = -0.5   // top 13.5, aria dall'icona
    private let pctFont = NSFont.monospacedSystemFont(ofSize: 9, weight: .bold)
    private let timeFont = NSFont.monospacedSystemFont(ofSize: 9, weight: .regular)
    private let rowTopBaseline: CGFloat = 9    // prima quota (5h)
    private let rowBotBaseline: CGFloat = 1    // seconda quota (7d)
    private let barW: CGFloat = 20      // minimo utile: il numero dà la precisione
    private let barH: CGFloat = 6
    private let pctW: CGFloat = 22      // "100%" fissa: al cambio cifra niente salta
    private let gap: CGFloat = 2
    private let timeGap: CGFloat = 3
    private let acctGap: CGFloat = 6    // uguale ovunque: niente separatori
    private let padX: CGFloat = 4
    // Tetto della barra: oltre, con troppi account, macOS la mette fuori schermo (23/10: 8 account = 970 pt, x -4411, invisibile).
    // Entrano gli account che stanno nel tetto (prima quelli attivi e quelli più carichi), il resto è «+N» e sta nel menu.
    // Il tetto è il 30% dello schermo principale (max 520 pt): la barra deve restare accanto alle altre icone e al notch.
    private var barMaxW: CGFloat { min(520, (NSScreen.main?.frame.width ?? 1440) * 0.3) }
    private var hiddenAccts = 0
    private var plusX: CGFloat = 0

    private func flat() -> [(Provider, Account)] {
        var out: [(Provider, Account)] = []
        for p in snapshot?.providers ?? [] {
            if p.menuOnly == true { continue }
            for a in p.accounts ?? [] { out.append((p, a)) }
        }
        return out
    }

    private func quotaWidth(_ q: Quota) -> CGFloat {
        let tagW = (q.key.uppercased() as NSString).size(withAttributes: [.font: tagFont]).width
        let timeW = (barTime(q) as NSString).size(withAttributes: [.font: timeFont]).width
        return tagW + gap + barW + gap + pctW + timeGap + timeW
    }

    // Email maiuscola, croppata con … oltre cap. Stessa stringa in
    // layout e disegno: si calcola qui una volta sola per cella.
    private func cropEmail(_ s: String, cap: CGFloat) -> String {
        let up = s.uppercased()
        let attrs: [NSAttributedString.Key: Any] = [.font: headerFont]
        if (up as NSString).size(withAttributes: attrs).width <= cap { return up }
        var t = up
        while t.count > 6,
              (t + "…" as NSString).size(withAttributes: attrs).width > cap {
            t.removeLast()
        }
        return t + "…"
    }

    // Badge testata: " ↻N" solo con reset manuali disponibili. Zero o
    // ignoti (Claude) = niente: la barra resta pulita, il menu dice tutto.
    private func resetBadge(_ a: Account) -> String {
        let n = a.resetCredits?.available ?? 0
        return n > 0 ? " ↻\(n)" : ""
    }

    // Un solo passaggio di layout per misura e disegno: niente derive tra i due.
    private struct AcctFrame {
        let acct: Account
        let header: String
        let badge: String
        let x: CGFloat
        let w: CGFloat
    }
    private struct GroupFrame {
        let prov: Provider
        let x: CGFloat
        let w: CGFloat
        let accts: [AcctFrame]
    }

    // Cella del ritmo: un cruscotto da 0× a 2× (verde fino a 1×, arancio fino a 1,3×, rosso oltre) con l'ago, e il valore sotto.
    // Il «69/69» (usato/atteso) sta nel menu: nella barra si legge l'ago, non due numeri.
    private let gaugeR: CGFloat = 10
    private let gaugeCY: CGFloat = 10.5
    private func paceCellWidth() -> CGFloat {
        guard let ps = paceSummary(snapshot) else { return 0 }
        return max(gaugeR * 2 + 3, (paceText(ps.ratio) as NSString).size(withAttributes: [.font: pctFont]).width)
    }
    private func drawGauge(ratio: Double, x: CGFloat, w: CGFloat) {
        let c = NSPoint(x: x + w / 2, y: gaugeCY)
        // 0× a sinistra (180°), 2× a destra (0°): l'angolo scende con il valore
        let ang = { (v: Double) -> CGFloat in CGFloat(180 - min(max(v, 0), 2) / 2 * 180) }
        for (from, to, st) in [(0.0, 1.0, "ok"), (1.0, 1.3, "warning"), (1.3, 2.0, "critical")] {
            let arc = NSBezierPath()
            arc.appendArc(withCenter: c, radius: gaugeR, startAngle: ang(from), endAngle: ang(to), clockwise: true)
            arc.lineWidth = 2.5
            let on = from == 0 || ratio > from
            statusColor(st).withAlphaComponent(on ? 0.95 : 0.35).setStroke()
            arc.stroke()
        }
        let a = ang(ratio) * .pi / 180
        let needle = NSBezierPath()
        needle.move(to: c)
        needle.line(to: NSPoint(x: c.x + cos(a) * (gaugeR - 1), y: c.y + sin(a) * (gaugeR - 1)))
        needle.lineWidth = 1.5; needle.lineCapStyle = .round
        NSColor.white.setStroke(); needle.stroke()
        NSColor.white.setFill()
        NSBezierPath(ovalIn: NSRect(x: c.x - 1.5, y: c.y - 1.5, width: 3, height: 3)).fill()
    }

    // Cella del Mac: quattro barre verticali affiancate (C CPU, G GPU, R RAM, D disco) con l'iniziale sotto e la tacca alla soglia di «impegnato».
    // In verticale ci stanno tutte e quattro nella larghezza che prima teneva due righe orizzontali; più larga,
    // la tray sparisce dietro il notch quando l'app in primo piano ha molti menu. I numeri stanno nel menu.
    private struct MacCol { let tag: String; let pct: Int; let limit: Int; let color: NSColor }
    private let macCols: [(String, String, Int)] = [("cpu", "C", 85), ("mem", "R", 80), ("gpu", "G", 80), ("disk", "D", 85)]   // stesso ordine del menu
    private let vBarW: CGFloat = 5
    private let vBarY: CGFloat = 9      // sopra la sigla
    private let vBarTop: CGFloat = 22
    private let colGap: CGFloat = 1     // affiancate: si leggono come un blocco solo
    private func macCell() -> [MacCol]? {
        guard let e = liveMac?.effort else { return nil }
        let tone = { (lv: Int) -> NSColor in lv == 0 ? statusColor("ok") : statusColor(lv == 1 ? "warning" : "critical") }
        let cols = macCols.compactMap { (key, tag, limit) -> MacCol? in
            guard let pp = e.parts.first(where: { $0.key == key }), let v = pp.pct else { return nil }
            return MacCol(tag: tag, pct: v, limit: limit, color: tone(pp.level))
        }
        return cols.isEmpty ? nil : cols
    }
    private func macColWidth(_ c: MacCol) -> CGFloat { max(vBarW, (c.tag as NSString).size(withAttributes: [.font: tagFont]).width) }
    private func macCellWidth() -> CGFloat {
        let cols = macCell() ?? []
        let mac = cols.isEmpty ? 0 : cols.map { macColWidth($0) }.reduce(0, +) + colGap * CGFloat(cols.count - 1)
        return remoteOffload() ? mac + (mac > 0 ? pcMarkGap : 0) + pcMarkW() : mac
    }
    // Segno del PC al lavoro: lo schermo sopra, la sigla sotto, come le colonne del Mac
    private let pcMarkGap: CGFloat = 4
    private func pcMarkW() -> CGFloat { max(9, ("PC" as NSString).size(withAttributes: [.font: tagFont]).width) }
    private func drawPCMark(x: CGFloat) {
        let w = pcMarkW(), tw = ("PC" as NSString).size(withAttributes: [.font: tagFont]).width
        drawBaseline("PC", x: x + (w - tw) / 2, baseline: rowBotBaseline, font: tagFont, color: .white, shadow: true)
        let cfg = NSImage.SymbolConfiguration(pointSize: 9, weight: .semibold).applying(.init(paletteColors: [.white]))
        if let img = NSImage(systemSymbolName: "desktopcomputer", accessibilityDescription: "PC al lavoro")?.withSymbolConfiguration(cfg) {
            let sz = img.size
            img.draw(in: NSRect(x: x + (w - sz.width) / 2, y: vBarY + (vBarTop - vBarY - sz.height) / 2, width: sz.width, height: sz.height))
        }
    }

    private func layout() -> (groups: [GroupFrame], width: CGFloat, macW: CGFloat) {
        if let c = cachedLayout { return c }
        let c = computeLayout()
        cachedLayout = c
        return c
    }

    private func computeLayout() -> (groups: [GroupFrame], width: CGFloat, macW: CGFloat) {
        let mw = macCellWidth()
        let pw = paceCellWidth()
        // Prima passata: larghezza di ogni account, senza posizioni.
        struct Cand { let acct: Account; let header: String; let badge: String; let w: CGFloat; let pi: Int; let ai: Int }
        var cands: [[Cand]] = []
        for (pi, p) in (snapshot?.providers ?? []).enumerated() {
            if p.menuOnly == true { cands.append([]); continue }
            cands.append((p.accounts ?? []).enumerated().map { (ai, a) in
                // larghezza = riga quota più larga; la mail si taglia a misura,
                // mai oltre. Le righe non si tagliano mai. Il badge non si taglia:
                // ruba spazio alla mail, non alle righe.
                let badge = resetBadge(a)
                let badgeW = (badge as NSString).size(withAttributes: [.font: headerFont]).width
                let qw = a.quotas.prefix(2).map { quotaWidth($0) }.max() ?? 0
                let header = cropEmail(a.label, cap: max(30, qw - iconIndent - badgeW))
                let hw = iconIndent
                    + (header as NSString).size(withAttributes: [.font: headerFont]).width
                    + badgeW
                return Cand(acct: a, header: header, badge: badge, w: max(hw, qw), pi: pi, ai: ai)
            })
        }
        // Quanti entrano nel tetto: prima gli attivi, poi chi ha la quota più alta. Si rimettono in ordine dopo.
        let start = padX + (mw > 0 ? mw + acctGap : 0) + (pw > 0 ? pw + acctGap : 0)
        let plusW = ("+9" as NSString).size(withAttributes: [.font: headerFont]).width + acctGap
        let all = cands.flatMap { $0 }
        let room = barMaxW - start - padX - plusW
        let ranked = all.sorted { x, y in
            if x.acct.active != y.acct.active { return x.acct.active }
            return (x.acct.quotas.map { $0.usedPct }.max() ?? 0) > (y.acct.quotas.map { $0.usedPct }.max() ?? 0)
        }
        var keep = Set<String>(), used: CGFloat = 0
        for c in ranked {
            let need = c.w + (keep.isEmpty ? 0 : acctGap)
            if used + need <= room || keep.isEmpty { keep.insert("\(c.pi).\(c.ai)"); used += need }
        }
        let total = all.count
        hiddenAccts = total - keep.count
        // Seconda passata: posizioni solo per chi resta, nell'ordine dei provider.
        var groups: [GroupFrame] = []
        var x = padX
        if mw > 0 { x += mw + acctGap }
        if pw > 0 { x += pw + acctGap }
        for (pi, p) in (snapshot?.providers ?? []).enumerated() {
            let shown = cands[pi].filter { keep.contains("\(pi).\($0.ai)") }
            if shown.isEmpty { continue }
            let gx = x
            var frames: [AcctFrame] = []
            for c in shown {
                frames.append(AcctFrame(acct: c.acct, header: c.header, badge: c.badge, x: x, w: c.w))
                x += c.w + acctGap
            }
            x -= acctGap
            groups.append(GroupFrame(prov: p, x: gx, w: x - gx, accts: frames))
            x += acctGap
        }
        if !groups.isEmpty { x -= acctGap }
        if hiddenAccts > 0 { plusX = x + acctGap; x = plusX + plusW - acctGap }
        return (groups, x + padX, mw)
    }

    func idealWidth() -> CGFloat {
        if isOffline || flat().isEmpty { return 26 }
        return layout().width
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.clear.setFill()
        dirtyRect.fill()
        if isOffline || flat().isEmpty {
            let s = "···" as NSString
            s.draw(at: NSPoint(x: 6, y: 4), withAttributes: [
                .font: NSFont.systemFont(ofSize: 12),
                .foregroundColor: NSColor.white,
            ])
            return
        }
        let (groups, _, macW) = layout()
        var px = padX
        if macW > 0 {
            let cols = macCell() ?? []
            var cx = px
            for c in cols {
                let w = macColWidth(c)
                let tw = (c.tag as NSString).size(withAttributes: [.font: tagFont]).width
                drawBaseline(c.tag, x: cx + (w - tw) / 2, baseline: rowBotBaseline, font: tagFont, color: .white, shadow: true)
                let h = vBarTop - vBarY
                let r = NSRect(x: cx + (w - vBarW) / 2, y: vBarY, width: vBarW, height: h)
                NSColor.white.withAlphaComponent(0.22).setFill()
                NSBezierPath(roundedRect: r, xRadius: 1.5, yRadius: 1.5).fill()
                let fh = h * CGFloat(min(100, max(0, c.pct))) / 100
                if fh > 0.5 {
                    NSGraphicsContext.saveGraphicsState()
                    NSBezierPath(roundedRect: r, xRadius: 1.5, yRadius: 1.5).setClip()
                    c.color.setFill()
                    NSRect(x: r.minX, y: r.minY, width: vBarW, height: fh).fill()
                    NSGraphicsContext.restoreGraphicsState()
                }
                // tacca alla soglia, larga quanto la barra: con le barre affiancate una tacca più larga si fonderebbe con la vicina
                NSColor.black.withAlphaComponent(0.55).setFill()
                NSRect(x: r.minX, y: r.minY + h * CGFloat(c.limit) / 100, width: vBarW, height: 1).fill()
                cx += w + colGap
            }
            if remoteOffload() { drawPCMark(x: cols.isEmpty ? px : cx - colGap + pcMarkGap) }
            px += macW + acctGap
        }
        if let ps = paceSummary(snapshot) {
            let pw = paceCellWidth()
            drawGauge(ratio: ps.ratio, x: px, w: pw)
            let t = paceText(ps.ratio), tw = (t as NSString).size(withAttributes: [.font: pctFont]).width
            drawBaseline(t, x: px + (pw - tw) / 2, baseline: rowBotBaseline, font: pctFont,
                         color: ps.ratio <= 1.0 ? .white : statusColor(paceStatus(ps.ratio)), shadow: true)
        }
        for g in groups {
            for f in g.accts {
                let a = f.acct
                // non attivo: barre dimezzate, testi quasi pieni (devono leggersi)
                let barDim: CGFloat = a.active ? 1 : 0.45
                let txtDim: CGFloat = a.active ? 1 : 0.8
                let white = NSColor.white.withAlphaComponent(txtDim)
                // -1px: l'inchiostro parte dentro il rettangolo, così il bordo
                // vivo dell'icona cade sulla stessa x delle righe (misurato).
                barIcon(g.prov.id, sizePt: iconSize)
                    .draw(in: NSRect(x: f.x - 1, y: iconY, width: iconSize, height: iconSize))
                drawBaseline(f.header, x: f.x + iconIndent, baseline: headerBaseline,
                             font: headerFont, color: white, shadow: true)
                if !f.badge.isEmpty {
                    let hw = (f.header as NSString).size(withAttributes: [.font: headerFont]).width
                    drawBaseline(f.badge, x: f.x + iconIndent + hw, baseline: headerBaseline,
                                 font: headerFont, color: white, shadow: true)
                }
                // due righe quota: 5H sopra, 7D sotto (o una sola se unica).
                // Partono a x0 come l'icona: niente gutter dedicato.
                let rows = a.quotas.prefix(2)
                for (ri, q) in rows.enumerated() {
                    let base = ri == 0 ? rowTopBaseline : rowBotBaseline
                    var cx = f.x
                    let tag = q.key.uppercased()
                    let tagW = (tag as NSString).size(withAttributes: [.font: tagFont]).width
                    drawBaseline(tag, x: cx, baseline: base + tagBaselineShift,
                                 font: tagFont, color: white, shadow: true)
                    cx += tagW + gap
                    // base+0: la barra centra il corpo dei numeri (base..+6.5),
                    // non galleggia sopra (base+1 la alzava di 1px).
                    let barRect = NSRect(x: cx, y: base, width: barW, height: barH)
                    NSColor.white.withAlphaComponent(0.22 * barDim).setFill()
                    NSBezierPath(roundedRect: barRect, xRadius: 2.5, yRadius: 2.5).fill()
                    let fw = barW * min(100, max(0, q.usedPct)).double / 100
                    if fw > 0.5 {
                        NSGraphicsContext.saveGraphicsState()
                        NSBezierPath(roundedRect: barRect, xRadius: 2.5, yRadius: 2.5).setClip()
                        statusColor(q.status).withAlphaComponent(barDim).setFill()
                        NSRect(x: barRect.minX, y: barRect.minY, width: fw, height: barH).fill()
                        NSGraphicsContext.restoreGraphicsState()
                    }
                    cx += barW + gap
                    // % nel colore di stato quando c'è un problema: l'occhio ci va da solo
                    let pctColor: NSColor = q.status == "ok"
                        ? white : statusColor(q.status).withAlphaComponent(txtDim)
                    let pct = "\(q.usedPct)%"
                    let pw = (pct as NSString).size(withAttributes: [.font: pctFont]).width
                    drawBaseline(pct, x: cx + (pctW - pw) / 2, baseline: base,
                                 font: pctFont, color: pctColor, shadow: true)
                    cx += pctW + timeGap
                    drawBaseline(barTime(q), x: cx, baseline: base,
                                 font: timeFont, color: white, shadow: true)
                }
            }
        }
        if hiddenAccts > 0 {
            drawBaseline("+\(hiddenAccts)", x: plusX, baseline: headerBaseline, font: headerFont, color: .white, shadow: true)
        }
    }
}

private extension Int {
    var double: CGFloat { CGFloat(self) }
}

// MARK: - Menu rows

private let menuW: CGFloat = 440

// Griglia unica del menu: ogni riga sotto un account usa queste colonne,
// così tag, barre, % e testi cadono sulla stessa x in tutto il menu.
//   lead │ TAG (46) │ barra (barW) │ % (38, a destra) │ dettaglio (170)
// Le x si ricavano l'una dall'altra, non si scrivono a mano: una sola
// larghezza di barra per quote, API, bonus e hub. Larghezze misurate coi
// font qui sotto (+ ~4pt di padding di NSTextField): "BONUS" 40.3,
// "100%" 32.9, dettaglio più lungo "€109.89/mese · rinnova 06/11" 153.
enum MenuGrid {
    static let lead: CGFloat = 38                       // = email account e nome sezione
    static let tagW: CGFloat = 46
    static let barX: CGFloat = lead + tagW + 4          // 88
    static let right: CGFloat = menuW - 16              // 424
    static let detailW: CGFloat = 170
    static let detailX: CGFloat = right - detailW       // 254
    static let pctW: CGFloat = 38
    static let pctX: CGFloat = detailX - 8 - pctW       // 208
    static let barW: CGFloat = pctX - 4 - barX          // 116
    static let barH: CGFloat = 8
    static let rowH: CGFloat = 22
    static let textY: CGFloat = 3
    static let textH: CGFloat = 16
    static let tagFont = NSFont.systemFont(ofSize: 11, weight: .semibold)
    // cifre tabulari: "79%" e "100%" finiscono sullo stesso bordo
    static let pctFont = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .semibold)
    static let detailFont = NSFont.monospacedDigitSystemFont(ofSize: 10.5, weight: .regular)
    static let labelFont = NSFont.systemFont(ofSize: 10.5)
}

// Soglie identiche a statusFor() del server: un colore, un significato.
func usageStatus(_ pct: Int) -> String {
    if pct >= 100 { return "depleted" }
    if pct >= 95 { return "critical" }
    if pct >= 80 { return "warning" }
    return "ok"
}

// Rapporto → percentuale intera, limitata: un tetto minuscolo non deve
// mandare in overflow Int() (crash), la % resta comunque "oltre 100".
func pctInt(_ ratio: Double) -> Int {
    Int(min(9999, max(-9999, (ratio * 100).rounded())))
}

// Soldi col segno prima del simbolo: "-$12.50", mai "$-12.50" (né "-$0.00").
func money(_ v: Double, decimals: Int = 2) -> String {
    let s = String(format: "$%.\(decimals)f", abs(v))
    let zero = String(format: "$%.\(decimals)f", 0.0)
    return v < 0 && s != zero ? "-" + s : s
}

private func gridLabel(_ text: String, x: CGFloat, w: CGFloat, font: NSFont,
                       color: NSColor, align: NSTextAlignment = .left) -> NSTextField {
    let l = NSTextField(labelWithString: text)
    l.font = font
    l.textColor = color
    l.alignment = align
    l.lineBreakMode = .byTruncatingTail
    l.frame = NSRect(x: x, y: MenuGrid.textY, width: w, height: MenuGrid.textH)
    return l
}

// Riga metrica: TAG · barra · % · dettaglio. Tutte le barre del menu passano
// da qui (quote, API, bonus, hub): stessa x, stessa larghezza. Barra e %
// dicono sempre il CONSUMATO: piena e rossa = finito, ovunque.
// ratio nil = rapporto ignoto (niente tetto, saldo assente): niente barra
// e "—", mai uno 0% inventato. Solo viste layer-backed, niente draw custom:
// si renderizza anche offscreen (--snapshot).
func metricRow(tag: String, ratio: Double?, status: String, detail: String,
               detailColor: NSColor = .secondaryLabelColor, tooltip: String? = nil) -> NSMenuItem {
    let g = MenuGrid.self
    let ratio = ratio.flatMap { $0.isFinite ? $0 : nil }
    let view = NSView(frame: NSRect(x: 0, y: 0, width: menuW, height: g.rowH))
    view.addSubview(gridLabel(tag, x: g.lead, w: g.tagW, font: g.tagFont, color: .labelColor))
    if let r = ratio {
        let track = NSView(frame: NSRect(x: g.barX, y: (g.rowH - g.barH) / 2,
                                         width: g.barW, height: g.barH))
        track.wantsLayer = true
        track.layer?.cornerRadius = g.barH / 2
        track.layer?.backgroundColor = NSColor.labelColor.withAlphaComponent(0.12).cgColor
        // oltre il 100% la barra resta piena: il numero vero lo dice la %
        let fw = (g.barW * CGFloat(min(1, max(0, r)))).rounded()
        if fw >= 1 {
            // mai più stretto che alto: un consumo minimo resta un pallino
            let fill = NSView(frame: NSRect(x: 0, y: 0, width: max(fw, g.barH), height: g.barH))
            fill.wantsLayer = true
            fill.layer?.cornerRadius = g.barH / 2
            fill.layer?.backgroundColor = statusColor(status).cgColor
            track.addSubview(fill)
        }
        view.addSubview(track)
    }
    // % nel colore di stato quando c'è un problema, come nella barra
    let pctText = ratio.map { "\(pctInt($0))%" } ?? "—"
    let pctColor: NSColor = ratio == nil ? .tertiaryLabelColor
        : status == "ok" ? .labelColor : statusColor(status)
    view.addSubview(gridLabel(pctText, x: g.pctX, w: g.pctW, font: g.pctFont,
                              color: pctColor, align: .right))
    view.addSubview(gridLabel(detail, x: g.detailX, w: g.detailW, font: g.detailFont,
                              color: detailColor))
    let item = NSMenuItem()
    item.view = view
    item.toolTip = tooltip
    return item
}

// Riga di testo (abbonamento, reset manuali, buchi): etichetta sotto
// TAG + barra, valore nella STESSA colonna dettaglio delle righe metriche.
func textRow(_ label: String, detail: String, labelColor: NSColor = .secondaryLabelColor,
             detailColor: NSColor = .secondaryLabelColor, tooltip: String? = nil) -> NSMenuItem {
    let g = MenuGrid.self
    let view = NSView(frame: NSRect(x: 0, y: 0, width: menuW, height: g.rowH))
    view.addSubview(gridLabel(label, x: g.lead, w: g.detailX - 8 - g.lead, font: g.labelFont,
                              color: labelColor))
    view.addSubview(gridLabel(detail, x: g.detailX, w: g.detailW, font: g.detailFont,
                              color: detailColor))
    let item = NSMenuItem()
    item.view = view
    item.toolTip = tooltip
    return item
}


// Sezione provider: tile con l'icona del brand + nome. Senza icona
// (altri account) il testo resta allineato alla stessa colonna.
func sectionRow(_ text: String, providerId: String?) -> NSMenuItem {
    let view = NSView(frame: NSRect(x: 0, y: 0, width: menuW, height: 26))
    if let id = providerId {
        let icon = NSImageView(frame: NSRect(x: 14, y: 4, width: 18, height: 18))
        icon.image = providerIcon(id)
        view.addSubview(icon)
    }
    let label = NSTextField(labelWithString: text)
    label.font = .systemFont(ofSize: 12, weight: .semibold)
    label.textColor = .labelColor
    label.frame = NSRect(x: MenuGrid.lead, y: 4, width: MenuGrid.right - MenuGrid.lead, height: 18)
    view.addSubview(label)
    let item = NSMenuItem()
    item.view = view
    return item
}

// Data compatta per le righe Abbonamento/Bonus: "2026-11-06" → "06/11".
func dayMonth(_ iso: String) -> String {
    let parts = iso.split(separator: "-")
    guard parts.count == 3, let m = Int(parts[1]), (1...12).contains(m),
          let d = Int(parts[2]), (1...31).contains(d) else { return iso }
    return String(format: "%02d/%02d", d, m)
}

// Account: pallino di stato + email su tutta la riga. Niente riepilogo a
// destra: era il doppione della riga quota peggiore subito sotto, e fuori
// griglia (allineato a destra, formato suo).
func accountRow(_ a: Account) -> NSMenuItem {
    let view = NSView(frame: NSRect(x: 0, y: 0, width: menuW, height: 26))
    let dot = NSView(frame: NSRect(x: 19, y: 9, width: 8, height: 8))
    dot.wantsLayer = true
    dot.layer?.cornerRadius = 4
    dot.layer?.backgroundColor = statusColor(a.status).cgColor
    view.addSubview(dot)
    let label = NSTextField(labelWithString: a.label)
    label.font = .systemFont(ofSize: 12, weight: a.active ? .semibold : .regular)
    label.textColor = .labelColor
    label.frame = NSRect(x: MenuGrid.lead, y: 4, width: MenuGrid.right - MenuGrid.lead, height: 18)
    label.lineBreakMode = .byTruncatingTail
    view.addSubview(label)
    let item = NSMenuItem()
    item.view = view
    item.toolTip = a.id
    return item
}



// Riga hub (a consumo): stessa griglia, barra solo con un tetto vero
// (status "unknown" = spesa senza tetto: niente barra e "—").
func hubQuotaRow(_ q: Quota) -> NSMenuItem {
    var detail = q.detail ?? ""
    if !q.resetText.isEmpty { detail += (detail.isEmpty ? "" : " · ") + "↻ \(q.resetText)" }
    return metricRow(tag: q.key.uppercased(),
                     ratio: q.status == "unknown" ? nil : Double(q.usedPct) / 100,
                     status: q.status, detail: detail, tooltip: q.note)
}







// Riga Abbonamento: costo, non saldo. Nome del servizio intero ("Muse Code",
// non "Code"): niente prefissi tolti, si legge uguale sotto ogni provider.
// Il dettaglio resta tenue: è un promemoria, non un consumo.
func subscriptionRow(_ r: Renewal, accountLabels: Set<String> = []) -> NSMenuItem {
    // Gli account già elencati sopra non si ripetono.
    var text = "Abbonamento \(r.service)"
    if !r.account.isEmpty, r.account != r.service, !accountLabels.contains(r.account) {
        text += " — \(r.account)"
    }
    let detail: String
    switch r.cycle {
    case "mensile":
        detail = r.amount + "/mese"
            + (r.renewsAt.map { " · rinnova \(dayMonth($0))" } ?? "")
    case "annuale":
        detail = r.amount + "/anno"
            + (r.renewsAt.map { " · rinnova \(dayMonth($0))" } ?? "")
    case "una tantum":
        detail = "\(r.amount) una tantum"
    case "disdetto":
        detail = "disdetto" + (r.renewsAt.map { " · \(dayMonth($0))" } ?? "")
    default:
        detail = [r.amount, r.renewsAt.map { "↻ \(dayMonth($0))" } ?? "", r.cycle]
            .filter { !$0.isEmpty }.joined(separator: " · ")
    }
    return textRow(text, detail: detail, detailColor: .tertiaryLabelColor,
                   tooltip: r.note.isEmpty ? nil : r.note)
}

// Epoch → "gg/mm" per le scadenze dei reset (dayMonth vuole ISO).
func dayMonthEpoch(_ epoch: Int) -> String {
    let f = DateFormatter()
    f.dateFormat = "dd/MM"
    return f.string(from: Date(timeIntervalSince1970: TimeInterval(epoch)))
}



// Oltre questa età il saldo bonus si dichiara vecchio. Sotto è rumore: il
// server marca stale anche un dato di 5' (sonda in cache FRESH 15' + poll),
// quindi la soglia sta appena sopra un giro di aggiornamento saltato.
let creditStaleS = 1200

// ISO "2026-11-05" → fine di quel giorno (ora locale): scaduto solo dopo.
func endOfDay(_ iso: String) -> Date? {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    guard let d = f.date(from: iso) else { return nil }
    return Calendar.current.date(byAdding: .day, value: 1, to: d)
}

// Bonus cloud: riga metrica come le quote. Barra e % = usato su concesso
// (stesso verso di 5H/7D e API), dettaglio = saldo rimasto + scadenza; il
// resto nel tooltip. Senza saldo (429, token) la riga resta e dice perché:
// sparire e riapparire confonde più di un'attesa dichiarata.
func creditRow(_ c: CloudCredit, now: Date = Date()) -> NSMenuItem {
    guard let left = c.remaining else {
        let token = c.reason == "token"
        return metricRow(tag: "BONUS", ratio: nil, status: "unknown",
                         detail: token ? "token scaduto" : "in aggiornamento…",
                         detailColor: .tertiaryLabelColor,
                         tooltip: token ? "Bonus cloud Max: apri Claude Code per rinnovare il token"
                                        : "Bonus cloud Max: saldo in aggiornamento")
    }
    // Senza tetto noto niente rapporto: il saldo sì, una barra finta no.
    let limit = c.limit.flatMap { $0 > 0 ? $0 : nil }
    let used = c.used ?? limit.map { $0 - left }
    let ratio = limit.flatMap { l in used.map { $0 / l } }
    let nowS = Int(now.timeIntervalSince1970)
    let old = c.stale == true && (c.asOf.map { nowS - $0 >= creditStaleS } ?? false)
    let expired = c.renewsAt.flatMap(endOfDay).map { $0 <= now } ?? false
    // scaduto o vecchio: grigio come il dato vecchio di Muse, mai verde
    let status = expired ? "off" : old ? "stale"
        : ratio.map { usageStatus(pctInt($0)) } ?? "unknown"
    var detail = "\(money(left)) rimasti"
    if expired, let r = c.renewsAt {
        detail = "\(money(left)) · scaduto \(dayMonth(r))"
    } else if old, let at = c.asOf {
        detail += " · \(staleAge(at, now: now))"
    } else if let r = c.renewsAt {
        detail += " · scade \(dayMonth(r))"
    }
    var tip = "Bonus cloud Max: \(money(left)) rimasti"
    if let l = limit { tip += " su \(money(l, decimals: 0))" }
    if let u = used { tip += " · usati \(money(u))" }
    if let r = c.renewsAt { tip += (expired ? " · scaduto " : " · scade ") + dayMonth(r) }
    if let at = c.asOf { tip += " · \(staleAge(at, now: now))" }
    return metricRow(tag: "BONUS", ratio: ratio, status: status, detail: detail,
                     detailColor: expired || old ? .tertiaryLabelColor : .secondaryLabelColor,
                     tooltip: tip)
}

func emailRow(_ email: String) -> NSMenuItem {
    // Email solo-fattura (non un account live): intestazione tenue senza pallino.
    let view = NSView(frame: NSRect(x: 0, y: 0, width: menuW, height: 22))
    let label = NSTextField(labelWithString: email)
    label.font = .systemFont(ofSize: 11)
    label.textColor = .secondaryLabelColor
    label.frame = NSRect(x: MenuGrid.lead, y: 3, width: MenuGrid.right - MenuGrid.lead, height: 16)
    label.lineBreakMode = .byTruncatingTail
    view.addSubview(label)
    let item = NSMenuItem()
    item.view = view
    return item
}

// Rinnovi raggruppati per email con la sua intestazione; le righe
// auto-nominate (service == account) restano da sole senza intestazione.
// Qui tray:false resta nascosto: sotto gli account live si usa comunque.
func addGroupedRenewals(_ rows: [Renewal], baseLabels: Set<String>,
                        menu: NSMenu, shown: inout Set<String>) {
    let rows = rows.filter { $0.tray != false }
    var keys: [String] = []
    for r in rows where !shown.contains(r.service + "|" + r.account) {
        if !keys.contains(r.account) { keys.append(r.account) }
    }
    for k in keys {
        let rs = rows.filter { $0.account == k && !shown.contains($0.service + "|" + $0.account) }
        if rs.allSatisfy({ $0.service == $0.account }) {
            for r in rs {
                menu.addItem(subscriptionRow(r, accountLabels: baseLabels))
                shown.insert(r.service + "|" + r.account)
            }
        } else {
            menu.addItem(emailRow(k))
            for r in rs {
                menu.addItem(subscriptionRow(r, accountLabels: baseLabels.union([k])))
                shown.insert(r.service + "|" + r.account)
            }
        }
    }
}


// x = 16 per i messaggi del menu intero (offline); x = lead sotto una
// sezione provider, allineato agli account che sostituisce.
func infoRow(_ text: String, x: CGFloat = 16) -> NSMenuItem {
    let view = NSView(frame: NSRect(x: 0, y: 0, width: menuW, height: 24))
    let label = NSTextField(labelWithString: text)
    label.font = .systemFont(ofSize: 11)
    label.textColor = .secondaryLabelColor
    label.frame = NSRect(x: x, y: 4, width: menuW - 16 - x, height: 16)
    view.addSubview(label)
    let item = NSMenuItem()
    item.view = view
    return item
}

// MARK: - Menu (clic e snapshot usano la stessa costruzione)

// Mappa dei bonus per email: credits del server nuovo, o il singolo credit
// del server vecchio. Senza: nessun bonus da mostrare.
func creditMap(_ snapshot: Overview?) -> [String: CloudCredit] {
    if let cs = snapshot?.credits { return cs }
    if let c = snapshot?.credit, let email = c.account, !email.isEmpty {
        return [email: c]
    }
    return [:]
}

// Preferenze della tray (persistenti): quale fascia e quale extra mostrare.
enum TrayPrefs {
    static let d = UserDefaults.standard
    static var showDaily: Bool {
        get { d.object(forKey: "showDaily") as? Bool ?? true }
        set { d.set(newValue, forKey: "showDaily") }
    }
    static var showApi: Bool {
        get { d.object(forKey: "showApi") as? Bool ?? true }
        set { d.set(newValue, forKey: "showApi") }
    }
    static var showBonus: Bool {
        get { d.object(forKey: "showBonus") as? Bool ?? true }
        set { d.set(newValue, forKey: "showBonus") }
    }
}

// Menu a livelli (18/10): in cima solo il verdetto e una riga per abbonamento,
// i dettagli (barre, grafici, rinnovi), il freno, i progetti e la legenda nei sottomenu.
func shortLabel(_ s: String) -> String { s.split(separator: "@").first.map(String.init) ?? s }

func providerSummary(_ p: Provider, now: Date = Date()) -> String {
    if p.error != nil { return "\(p.name)   non raggiungibile" }
    let accs = p.accounts ?? []
    if accs.isEmpty { return "\(p.name)   nessun account" }
    let parts = accs.map { a -> String in
        let name = shortLabel(a.label)
        guard let w = a.quotas.first(where: { $0.key.lowercased() == "7d" }) ?? a.quotas.first else { return name }
        if p.billing == "usage" { return "\(name) \(w.detail ?? "\(w.usedPct)%")" }
        if w.usedPct >= 100 { return "\(name) esaurito, torna fra \(w.resetText)" }
        var s = "\(name) \(w.usedPct)%"
        if w.key.lowercased() == "7d", let r = w.resetsAt {
            let elapsed = min(max(1 - (Double(r) - now.timeIntervalSince1970) / (7 * 86400), 0), 1)
            if elapsed >= 0.05 { s += " (\(paceText(Double(w.usedPct) / (elapsed * 100))))" }
        }
        return s
    }
    return "\(p.name)   " + parts.joined(separator: " · ")
}


func untilText(_ ms: Double?) -> String {
    guard let ms = ms else { return "" }
    let f = DateFormatter(); f.locale = Locale(identifier: "it_IT")
    let d = Date(timeIntervalSince1970: ms / 1000)
    f.dateFormat = Calendar.current.isDateInToday(d) ? "'oggi' HH:mm" : Calendar.current.isDateInTomorrow(d) ? "'domani' HH:mm" : "EEE d HH:mm"
    return f.string(from: d)
}

func gateLine(_ g: GateResult) -> String {
    if g.go { return g.provider == "free" ? "canali gratis" : "\(g.provider ?? "?") \(shortLabel(g.account ?? ""))".trimmingCharacters(in: .whitespaces) }
    return g.waitUntil != nil ? "aspetta fino a \(untilText(g.waitUntil))" : "fermo"
}


// MARK: - Grammatica visiva del menu (18/10)
// Ogni voce: icona SF Symbol a sinistra (template, mai emoji), riga 1 in colonne con tab stop,
// riga 2 piccola e grigia per il perché. Le righe a più linee crescono in altezza, niente troncamenti.
let providerSymbols = ["free": "leaf"]
let toneOK = NSColor.systemGreen, toneWarn = NSColor.systemOrange, toneBad = NSColor.systemRed

func sym(_ name: String, pt: CGFloat = 13, color: NSColor? = nil) -> NSImage? {
    guard let base = NSImage(systemSymbolName: name, accessibilityDescription: nil) else { return nil }
    var cfg = NSImage.SymbolConfiguration(pointSize: pt, weight: .regular)
    if let c = color { cfg = cfg.applying(NSImage.SymbolConfiguration(paletteColors: [c])) }
    let img = base.withSymbolConfiguration(cfg) ?? base
    img.isTemplate = (color == nil)
    return img
}
// Provider con un logo (Claude, Codex, Muse) → il logo vero; gli altri (canali gratis) → SF Symbol.
func providerSym(_ id: String, pt: CGFloat = 13, color: NSColor? = nil) -> NSImage? { brandGlyph(id, pt: pt) ?? sym(providerSymbols[id] ?? "circle", pt: pt, color: color) }
func prioritySym(_ p: String) -> NSImage? {
    switch p {
    case "alta": return sym("arrow.up", color: toneWarn)
    case "bassa": return sym("arrow.down", color: NSColor.systemTeal)
    default: return sym("minus", color: NSColor.secondaryLabelColor)
    }
}

let rowFont = NSFont.systemFont(ofSize: 13)
let rowBold = NSFont.systemFont(ofSize: 13, weight: .semibold)
let rowNum = NSFont.monospacedDigitSystemFont(ofSize: 12.5, weight: .regular)
let rowSmall = NSFont.systemFont(ofSize: 10.5)

func tabbed(_ tabs: [CGFloat]) -> NSMutableParagraphStyle {
    let ps = NSMutableParagraphStyle()
    ps.tabStops = tabs.map { NSTextTab(textAlignment: .right, location: $0, options: [:]) }
    ps.defaultTabInterval = 0
    ps.lineBreakMode = .byClipping
    return ps
}
func txt(_ s: String, _ font: NSFont = rowFont, _ color: NSColor = .labelColor) -> NSAttributedString {
    NSAttributedString(string: s, attributes: [.font: font, .foregroundColor: color])
}
func inlineIcon(_ name: String, color: NSColor = .secondaryLabelColor, provider: Bool = false) -> NSAttributedString {
    let att = NSTextAttachment()
    att.image = provider ? providerSym(name, pt: 11, color: color) : sym(name, pt: 11, color: color)
    att.bounds = NSRect(x: 0, y: -2, width: 13, height: 12)
    return NSAttributedString(attachment: att)
}
// Una riga del menu: la riga 1 è già composta (colonne con \t), la riga 2 è testo piccolo che va a capo da solo.
func richRow(icon: NSImage?, _ line1: NSAttributedString, detail: String? = nil, detailAttr: NSAttributedString? = nil, tabs: [CGFloat] = [], enabled: Bool = true, tip: String? = nil, wrap: Int = 62) -> NSMenuItem {
    let out = NSMutableAttributedString(attributedString: line1)
    if let da = detailAttr { out.append(txt("\n")); out.append(da) } else    if let d = detail, !d.isEmpty {
        out.append(txt("\n"))
        out.append(txt(wrapText(d, wrap), rowSmall, .secondaryLabelColor))
    }
    out.addAttribute(.paragraphStyle, value: tabbed(tabs), range: NSRange(location: 0, length: out.length))
    let it = NSMenuItem(); it.attributedTitle = out; it.image = icon; it.isEnabled = true // le righe disabilitate AppKit le sbiadisce: illeggibili
    it.toolTip = tip
    return it
}
func wrapText(_ s: String, _ width: Int) -> String {
    var lines: [String] = [], cur = ""
    for w in s.split(separator: " ") {
        if !cur.isEmpty && cur.count + 1 + w.count > width { lines.append(cur); cur = String(w) } else { cur += (cur.isEmpty ? "" : " ") + String(w) }
    }
    if !cur.isEmpty { lines.append(cur) }
    return lines.joined(separator: "\n")
}
func headRow(_ cols: [String], tabs: [CGFloat]) -> NSMenuItem {
    let a = NSMutableAttributedString()
    for (i, c) in cols.enumerated() { if i > 0 { a.append(txt("\t")) }; a.append(txt(c, .systemFont(ofSize: 10, weight: .semibold), .secondaryLabelColor)) }
    let it = richRow(icon: nil, a, tabs: tabs); it.isEnabled = false
    return it
}
func noteRow(_ text: String, icon: String? = nil) -> NSMenuItem {
    richRow(icon: icon.flatMap { sym($0) }, txt(wrapText(text, 66), rowSmall, .secondaryLabelColor), enabled: false)
}
func resetText(_ epoch: Int) -> String {
    let f = DateFormatter(); f.locale = Locale(identifier: "it_IT"); f.dateFormat = "EEE HH:mm"
    return f.string(from: Date(timeIntervalSince1970: Double(epoch)))
}
func pName(_ id: String) -> String { id == "codex" ? "Codex" : id.capitalized }

// MARK: stato complessivo in cima

enum Level { case ok, warn, bad }
// Gli abbonamenti frenati vengono dalla stessa fonte del badge sugli account: /api/gates (providers).
func brakedProviders() -> [String] { ["claude", "codex", "muse"].filter { liveGates?.providers?[$0]?.state == "frenato" } }
func timesShort(_ x: Double) -> String { x >= 10 ? "oltre 10×" : String(format: "%.1f×", x).replacingOccurrences(of: ".", with: ",") }
// Il verdetto nomina l'account, non il provider: «Claude zorahrel» può correre mentre Claude resta libero su un altro account.
// MARK: il Mac: carico, memoria, chi pesa, agenti in pausa

func gbText(_ mb: Double) -> String { mb >= 1024 ? String(format: "%.1f GB", mb / 1024).replacingOccurrences(of: ".", with: ",") : String(format: "%.0f MB", mb) }
func coreText(_ c: Double) -> String { String(format: "%.1f", c).replacingOccurrences(of: ".", with: ",") }
func resText(_ r: AgentRes) -> String { (r.shared != nil ? "~" : "") + "\(coreText(r.cpu)) core · \(gbText(r.memMB))" }

// Il Mac in una riga sola: livello e perché in grassetto, sotto le quattro misure; se soffre, chi pesa e chi è in pausa.
// Il Mac come un account: una barra per misura con la tacca alla soglia di «impegnato» e il grafico delle 24 h accanto.
let macLimits: [String: Double] = ["cpu": 85, "mem": 80, "gpu": 80, "disk": 85]
func macRow() -> NSMenuItem? {
    guard let m = liveMac, let e = m.effort else { return nil }
    // RAM e disco dall'hub, come la dashboard: una fonte sola, gli stessi numeri ovunque
    let mem = m.mem, disk = m.disk
    let tone: NSColor = e.level == 0 ? toneOK : e.level == 1 ? toneWarn : toneBad
    let bars = e.parts.compactMap { p -> BarSpec? in
        guard let pct = p.pct else { return nil }
        let col: NSColor = p.level == 0 ? toneOK : p.level == 1 ? toneWarn : toneBad
        let hist = m.history?[p.key] ?? []
        // Il picco comprende la lettura di adesso: lo storico va a minuti e può non averla ancora.
        var note = "picco \(max(Int(hist.map { $0.v }.max() ?? 0), pct))%"
        // Accanto alla % la quantità vera: quanti core, quanti GB, quanto spazio libero (letti dal kernel, MacStats.swift).
        if p.key == "cpu" { note = (p.load ?? 0) >= 1 ? "\(coreText(p.load ?? 0)) in fila/core" : "\(coreText(Double(pct) / 100 * Double(m.cores))) di \(m.cores) core" }
        if p.key == "mem", let mem = mem { note = "\(gbNum(mem.usedGB)) di \(gbNum(mem.totalGB))" }
        if p.key == "gpu" { note = "picco 24 h \(max(Int(hist.map { $0.v }.max() ?? 0), pct))%" }
        if p.key == "disk", let d = disk { note = "\(gbNum(d.freeGB)) liberi" }
        return BarSpec(label: p.key == "mem" ? "RAM" : p.name.prefix(1).uppercased() + p.name.dropFirst(), frac: Double(pct) / 100, mark: macLimits[p.key].map { $0 / 100 },
                       color: col, value: "\(pct)%", spark: hist.count > 1 ? hist : nil, note: note)
    }
    var lines: [String] = []
    if e.level > 0 { lines.append((e.why.isEmpty ? "" : e.why.prefix(1).uppercased() + e.why.dropFirst() + " · ") + "pesa di più: " + m.hogs.prefix(3).map { "\($0.name) \(gbText($0.memMB))" }.joined(separator: ", ")) }
    if !m.paused.isEmpty { lines.append("In pausa finché respira: " + m.paused.map { $0.label }.joined(separator: ", ")) }
    if let g = liveTrust?.items.filter({ $0.level == "grave" }), !g.isEmpty { lines.append("Processi sospetti: " + g.prefix(3).map { $0.name }.joined(separator: ", ") + " (passa qui per i motivi)") }
    let tip = "Conta la misura più vicina alla sua soglia (la tacca): CPU 85/97% o oltre 1/1,5 processi in fila per core, memoria 80/92% di pressione o swap sostenuta, GPU 80/95%, disco 85/95%. Sotto sforzo, gli agenti in background di priorità bassa vanno in pausa e ripartono da soli; le sessioni aperte non si fermano mai."
    let it = NSMenuItem()
    let v = AccountBlockView(icon: sym("cpu", pt: 14, color: .labelColor), name: "Mac", caption: "\(m.cores) core · ultime 24 h", badge: e.label, badgeColor: tone,
                             brake: lines.isEmpty ? nil : lines.joined(separator: " · "), bars: bars, single: nil)
    // RAM e GPU per esteso sotto i riquadri, come Activity Monitor: cosa occupa la memoria, quanto resta, la swap
    if let mem = mem {
        let pres = e.parts.first { $0.key == "mem" }?.pct
        v.foot = "RAM: app \(gbNum(mem.appGB)) · wired \(gbNum(mem.wiredGB)) · compressa \(gbNum(mem.compressedGB)) · cache \(gbNum(mem.cachedGB)) · libera \(gbNum(mem.freeGB))\n"
            + (pres.map { "pressione \($0)% · " } ?? "") + "swap \(gbNum(m.swapUsedGB ?? 0)) di \(gbNum(m.swapTotalGB ?? 0))" + (m.swapSustained ? ", rilegge da disco" : "")
            + (e.parts.first { $0.key == "gpu" }?.pct.map { " · GPU \($0)% adesso" } ?? "")
    }
    v.vertical = true
    v.toolTip = tip; it.view = v; it.toolTip = tip
    it.submenu = macProcs.newMenu()   // al passaggio: chi pesa adesso, per CPU e per memoria
    return it
}

// Una macchina come card: stato a parole nel badge, una misura per riquadro col grafico 24 h quando c'è, sotto cosa pesa.
// Senza misure (spenta, addormentata) una riga sola. La macchina su cui gira la tray ha i processi nel sottomenu.
// I lavori nostri sulla macchina (offload) uno per riga, in testa; il resto in una riga come prima
func machineText(_ lines: [String], jobs: Int) -> String {
    guard jobs > 0 else { return lines.joined(separator: " · ") }
    let rest = Array(lines.dropFirst(jobs))
    return (Array(lines.prefix(jobs)) + (rest.isEmpty ? [] : [rest.joined(separator: " · ")])).joined(separator: "\n")
}
func machineItem(_ m: Machine) -> NSMenuItem {
    let tone: (Int) -> NSColor = { $0 == 0 ? toneOK : $0 == 1 ? toneWarn : toneBad }
    var lines = m.lines
    if m.local, let g = liveTrust?.items.filter({ $0.level == "grave" }), !g.isEmpty { lines.append("Processi sospetti: " + g.prefix(3).map { $0.name }.joined(separator: ", ") + " (passa qui per i motivi)") }
    let bars = m.metrics.map { x in
        BarSpec(label: x.name, frac: Double(x.pct) / 100, mark: x.limit.map { $0 / 100 }, color: tone(x.level), value: "\(x.pct)%",
                spark: (x.history?.count ?? 0) > 1 ? x.history : nil, note: x.note)
    }
    let quiet = m.metrics.isEmpty
    // senza misure la riga sotto dice cosa aspettarsi (la didascalia), lo stato è già nel badge
    let v = AccountBlockView(icon: sym(m.local ? "laptopcomputer" : "desktopcomputer", pt: 14, color: .labelColor), name: m.name, caption: quiet ? nil : m.caption,
                             badge: m.state, badgeColor: quiet && m.level == 0 ? .secondaryLabelColor : tone(m.level),
                             brake: lines.isEmpty ? nil : machineText(lines, jobs: m.offload ?? 0), bars: bars,
                             single: quiet ? txt(m.caption ?? "nessuna misura adesso", rowSmall, .secondaryLabelColor) : nil)
    if !quiet { v.foot = m.foot; v.vertical = true }
    let it = NSMenuItem()
    let tip = "Conta la misura più vicina alla sua soglia (la tacca). Sotto sforzo, gli agenti in background di priorità bassa vanno in pausa e ripartono da soli; le sessioni aperte non si fermano mai."
    v.toolTip = tip; it.view = v; it.toolTip = tip
    v.autoresizingMask = [.width]   // larga quanto il menu, allineata alla griglia degli account
    if m.local { it.submenu = macProcs.newMenu() }   // al passaggio: chi pesa adesso, per CPU e per memoria
    return it
}

// Il PC di casa in una riga sotto il Mac: verde quando lavora, grigio quando dorme o è fermo, arancio quando
// il Mac è carico e il PC dorme (lì il lavoro pesante andrebbe con `offload`, che lo sveglia da solo).
func pcRow() -> [NSMenuItem] {
    guard let p = livePc else { return [] }
    let col: NSColor = p.avviso ? toneWarn : p.pc == "lavora" ? toneOK : .secondaryLabelColor
    let a = NSMutableAttributedString()
    a.append(txt("PC di casa  ")); a.append(txt(p.pc, .systemFont(ofSize: 13, weight: .semibold), col))
    let why = (p.pc == "lavora" ? p.perche : nil) ?? ""
    var rows = [richRow(icon: sym("desktopcomputer", color: col), a, detail: why, enabled: false,
                        tip: "dorme dopo 20 minuti senza lavoro; offload e winwake lo svegliano")]
    if p.avviso, let m = p.mac, let s = p.soglia {
        rows.append(noteRow("Mac a " + String(format: "%.1f", m).replacingOccurrences(of: ".", with: ",") + " per core (soglia "
            + String(format: "%.1f", s).replacingOccurrences(of: ".", with: ",") + ") e il PC dorme: suite e build vanno lanciate con offload", icon: "exclamationmark.triangle"))
    }
    return rows
}

// Le automazioni in una riga fissa, sempre (anche con l'hub giù: il «?» dice che non si sa, non che va tutto bene).
func automationsRow(actionTarget: AnyObject?) -> NSMenuItem {
    var text = "Automazioni · ?", gray = false
    if let a = liveAuto {
        let stale = a.sources.contains { !$0.ok && $0.pending != true }
        var parts: [String] = []
        if a.needsYou > 0 { parts.append(a.needsYou == 1 ? "1 ti aspetta" : "\(a.needsYou) ti aspettano") }
        if a.broken > 0 { parts.append(a.broken == 1 ? "1 rotta" : "\(a.broken) rotte") }
        if stale { parts.append("?") }
        if !parts.isEmpty { text = "Automazioni · " + parts.joined(separator: " · ") }
        else if !stale { text = "Automazioni · tutto a posto"; gray = true }
    }
    let row = richRow(icon: sym("clock.arrow.circlepath"), txt(text, rowFont, gray ? .secondaryLabelColor : .labelColor),
                      tip: "Apre le automazioni nella dashboard")
    row.action = #selector(AppDelegate.openAutomations); row.target = actionTarget
    return row
}

// Sottomenu del Mac: i processi raggruppati per app, letti in-process (ProcSampler) solo quando il menu è aperto.
// La CPU è la media fra l'apertura del menu (prime) e il passaggio sul Mac: due letture, nessun timer a menu chiuso.
final class MacProcMenu: NSObject, NSMenuDelegate {
    private let sampler = ProcSampler(), queue = DispatchQueue(label: "macprocs")
    private var primedAt = Date.distantPast
    // un menu nuovo a ogni ricostruzione: un sottomenu non può stare sotto due voci, e la vecchia voce lo terrebbe ancora
    func newMenu() -> NSMenu { let m = NSMenu(); m.delegate = self; m.autoenablesItems = false; m.addItem(noteRow("Leggo i processi…")); return m }
    func prime() { primedAt = Date(); queue.async { [sampler] in sampler.reset(); _ = sampler.sample() } }
    func menuNeedsUpdate(_ m: NSMenu) {
        // dal prime almeno mezzo secondo, sennò la CPU è rumore: si aspetta il resto (succede solo se il mouse va dritto sul Mac)
        let wait = 0.5 - Date().timeIntervalSince(primedAt)
        if wait > 0 && wait <= 0.5 { Thread.sleep(forTimeInterval: wait) }
        let rows = queue.sync { sampler.sample() }
        fill(m, rows: rows)
    }
    private var lastRows: [ProcRow] = []
    private let tabs: [CGFloat] = [275, 355]
    private func cpuText(_ c: Double) -> String { c >= 100 ? String(format: "%.1f core", c / 100).replacingOccurrences(of: ".", with: ",") : "\(Int(c.rounded()))%" }
    // Una riga processo (o app con i suoi helper): CPU e memoria in colonna, e al passaggio il suo sottomenu
    // con cosa è, i processi che la compongono e i comandi per chiuderla. Tutto dalla tray, senza finestre.
    private func procItem(_ r: ProcRow, members: [ProcRow], depth: Int = 0) -> NSMenuItem {
        let n = r.name.count > 30 ? r.name.prefix(29) + "…" : r.name   // oltre, entra nella colonna CPU
        let l = NSMutableAttributedString(attributedString: txt(n + (r.count > 1 ? "  ×\(r.count)" : ""), r.system ? rowFont : rowBold, r.system ? .secondaryLabelColor : .labelColor))
        l.append(txt("\t" + cpuText(r.cpu), rowNum, r.cpu >= 80 ? toneWarn : .secondaryLabelColor))
        l.append(txt("\t" + bytesText(r.mem), rowNum, r.mem >= 2_000_000_000 ? toneWarn : .secondaryLabelColor))
        let flags = trustOf(members.map { $0.pid } + [r.pid])
        let worst = flags.contains { $0.level == "grave" } ? toneBad : flags.contains { $0.level == "attenzione" } ? toneWarn : nil
        let it = richRow(icon: worst.flatMap { sym("exclamationmark.shield.fill", color: $0) }, l, tabs: tabs)
        let sm = NSMenu(); sm.autoenablesItems = false
        let what = r.count > 1 ? "\(r.count) processi · PID principale \(r.pid)" : "PID \(r.pid)" + (r.threads > 0 ? " · \(r.threads) thread" : "")
        sm.addItem(richRow(icon: sym(r.system ? "lock" : "gearshape"), txt(r.name, rowBold), detail: what + (r.system ? " · processo di macOS, non si chiude da qui" : "") + (r.detail.isEmpty ? "" : "\n" + (r.detail.count > 220 ? r.detail.prefix(219) + "…" : r.detail)), wrap: 70))   // gli argomenti di un claude sono kilobyte
        for f in flags where f.level != "ok" || !f.reasons.isEmpty {
            sm.addItem(richRow(icon: sym("exclamationmark.shield", color: f.level == "grave" ? toneBad : f.level == "attenzione" ? toneWarn : .secondaryLabelColor),
                               txt(f.level == "ok" ? "Da sapere" : f.level == "grave" ? "Sospetto" : "Da guardare", rowBold, f.level == "grave" ? toneBad : f.level == "attenzione" ? toneWarn : .labelColor),
                               detail: (flags.count > 1 ? "\(f.name) (pid \(f.pid)): " : "") + f.reasons.joined(separator: " · ") + (f.signer.map { " · firma: \($0)" } ?? ""), wrap: 70))
        }
        if r.count > 1 && depth == 0 {
            sm.addItem(.separator())
            sm.addItem(headRow(["PROCESSI DELL'APP", "CPU", "memoria"], tabs: tabs))
            for c in members.sorted(by: { $0.cpu + $0.mem / 1e9 > $1.cpu + $1.mem / 1e9 }).prefix(12) { sm.addItem(procItem(c, members: [c], depth: 1)) }
            if members.count > 12 { sm.addItem(noteRow("e altri \(members.count - 12)")) }
        }
        let (ok, _) = killSplit(members)
        if !ok.isEmpty {
            sm.addItem(.separator())
            for force in [false, true] {
                let k = NSMenuItem(title: (force ? "Forza chiusura" : "Chiudi") + (ok.count > 1 ? " (\(ok.count) processi)" : ""), action: #selector(MacProcMenu.kill(_:)), keyEquivalent: "")
                k.target = self; k.image = sym(force ? "xmark.octagon" : "xmark.circle", color: force ? toneBad : .labelColor)
                k.representedObject = ["pids": ok.map { $0.pid }, "force": force] as [String: Any]
                sm.addItem(k)
            }
        }
        it.submenu = sm
        return it
    }
    func fill(_ m: NSMenu, rows: [ProcRow]) {
        lastRows = rows
        let apps = groupByApp(rows, all: rows)
        let membersOf = { (g: ProcRow) in rows.filter { g.pids.contains($0.pid) } }
        m.removeAllItems()
        if let t = liveTrust {
            let bad = t.items.filter { $0.level != "ok" }
            let g = t.counts["grave"] ?? 0, a = t.counts["attenzione"] ?? 0
            let head = richRow(icon: sym(bad.isEmpty ? "checkmark.shield" : "exclamationmark.shield.fill", color: g > 0 ? toneBad : a > 0 ? toneWarn : toneOK),
                               txt(bad.isEmpty ? "Processi attendibili" : g > 0 ? "\(g) sospett\(g == 1 ? "o" : "i")" + (a > 0 ? " · \(a) da guardare" : "") : "\(a) da guardare", rowBold),
                               detail: "firma, da dove gira, porte aperte alla rete, CPU alta da 10 min · \(t.counts["ok"] ?? 0) ok · gli agenti leggono GET :3360/api/mac/trust")
            if !bad.isEmpty {
                let tm = NSMenu(); tm.autoenablesItems = false
                for f in bad {
                    let row = lastRows.first { $0.pid == f.pid } ?? ProcRow(pid: f.pid, name: f.name, detail: f.path, cpu: 0, mem: 0, threads: 0, respPid: f.pid)
                    tm.addItem(procItem(row, members: [row], depth: 1))
                }
                head.submenu = tm
            }
            m.addItem(head); m.addItem(.separator())
        }
        m.addItem(headRow(["PIÙ CPU ADESSO", "CPU", "memoria"], tabs: tabs))
        apps.sorted { $0.cpu == $1.cpu ? $0.pid < $1.pid : $0.cpu > $1.cpu }.prefix(7).forEach { m.addItem(procItem($0, members: membersOf($0))) }
        m.addItem(.separator())
        m.addItem(headRow(["PIÙ MEMORIA", "CPU", "memoria"], tabs: tabs))
        apps.sorted { $0.mem == $1.mem ? $0.pid < $1.pid : $0.mem > $1.mem }.prefix(5).forEach { m.addItem(procItem($0, members: membersOf($0))) }
        m.addItem(.separator())
        // tutte le app, in ordine di peso: si scorre nel menu, ognuna col suo sottomenu
        let every = richRow(icon: sym("list.bullet.rectangle"), txt("Tutte le app (\(apps.count)) · \(rows.count) processi", rowFont), detail: "CPU totale \(cpuText(rows.reduce(0) { $0 + $1.cpu })) · 100% = un core intero")
        let em = NSMenu(); em.autoenablesItems = false
        em.addItem(headRow(["APP E PROCESSI, DAI PIÙ PESANTI", "CPU", "memoria"], tabs: tabs))
        let ranked = apps.sorted(by: { ($0.cpu / 100 + $0.mem / 2e9) > ($1.cpu / 100 + $1.mem / 2e9) })
        for g in ranked.prefix(60) { em.addItem(procItem(g, members: membersOf(g))) }   // oltre 60 il menu non si scorre più a mano
        if ranked.count > 60 { em.addItem(noteRow("altre \(ranked.count - 60) app leggere: «Cerca in una finestra…»")) }
        every.submenu = em
        m.addItem(every)
        let win = NSMenuItem(title: "Cerca in una finestra…", action: #selector(MacProcMenu.open(_:)), keyEquivalent: "")
        win.target = self; win.image = sym("magnifyingglass")
        m.addItem(win)
    }
    // Sezione nel menu principale: le app che pesano di più adesso (CPU + memoria), lette al volo. Le righe nascono vuote
    // e si riempiono mezzo secondo dopo l'apertura (la CPU è la media tra due letture), con il menu già aperto.
    func inlineSection(count n: Int = 5) -> [NSMenuItem] {
        let head = headRow(["PESANO DI PIÙ ADESSO", "CPU", "memoria"], tabs: tabs)
        let slots = (0..<n).map { _ in noteRow("…") }
        let apply: ([ProcRow]) -> Void = { [weak self] rows in
            guard let self else { return }
            self.lastRows = rows
            let top = groupByApp(rows, all: rows).sorted { ($0.cpu / 100 + $0.mem / 2e9) > ($1.cpu / 100 + $1.mem / 2e9) }.prefix(n)
            for (slot, g) in zip(slots, top) {
                let it = self.procItem(g, members: rows.filter { g.pids.contains($0.pid) })
                let sm = it.submenu; it.submenu = nil
                slot.attributedTitle = it.attributedTitle; slot.image = it.image; slot.submenu = sm
            }
        }
        if snapshotMode { prime(); Thread.sleep(forTimeInterval: 0.6); apply(queue.sync { sampler.sample() }); return [head] + slots }
        queue.asyncAfter(deadline: .now() + 0.6) { [sampler] in
            let rows = sampler.sample()
            RunLoop.main.perform(inModes: [.common, .eventTracking]) { apply(rows) }
        }
        return [head] + slots
    }
    @objc func open(_ s: NSMenuItem) { ProcessWindowController.shared.show(query: s.representedObject as? String ?? "") }
    @objc func kill(_ s: NSMenuItem) {
        guard let o = s.representedObject as? [String: Any], let pids = o["pids"] as? [pid_t], let force = o["force"] as? Bool else { return }
        let (ok, blocked) = killSplit(lastRows.filter { pids.contains($0.pid) })
        guard !ok.isEmpty else { return }
        NSApp.activate(ignoringOtherApps: true)
        guard killAlert(ok: ok, blocked: blocked, force: force).runModal() == .alertFirstButtonReturn else { return }
        let failed = queue.sync { killRows(ok, force: force, startTime: sampler.startTime) }
        if !failed.isEmpty { let a = NSAlert(); a.messageText = "Non chiusi (permesso negato)"; a.informativeText = failed.joined(separator: ", "); a.runModal() }
    }
}
let macProcs = MacProcMenu()
// MARK: abbonamenti (livello 1): una sezione compatta per account (settimana, oggi, 5 ore)

let blockW: CGFloat = 540
// AppKit mette ~103 pt attorno al testo di una riga (immagine, margini): oltre questo il menu si allarga più delle card
let menuTextMax: CGFloat = blockW - 104
// Una riga del blocco: etichetta, barra (con tacca), numero in grassetto, grafico dell'andamento, scadenza in breve.
// Il grafico sta accanto al numero: si legge «quanto» e «come ci sono arrivato» nello stesso colpo d'occhio.
struct BarSpec {
    let label: String; let frac: Double; let mark: Double?; let color: NSColor
    let value: String; let spark: [HistoryPoint]?; let note: String
    var scaleMax: Double = 100   // il ritmo usa 0…2× con la tacca a 1×
}
final class AccountBlockView: NSView {
    let icon: NSImage?, name: String, caption: String?, badge: String?, badgeColor: NSColor, brake: String?, bars: [BarSpec], single: NSAttributedString?
    static let rowH: CGFloat = 20, labelX: CGFloat = 38, barX: CGFloat = 92, barW: CGFloat = 120, barH: CGFloat = 6
    static let valueX: CGFloat = 220, sparkX: CGFloat = 268, sparkW: CGFloat = 120, sparkH: CGFloat = 14, noteX: CGFloat = 398
    // Mac: riquadri affiancati (vedi drawCards) al posto delle righe
    var vertical = false { didSet { resize(); removeAllToolTips(); tipStrings = []; addSparkTips(); applySnapshotHover(); needsDisplay = true } }   // i grafici cambiano posto
    // Il grafico da fermo dice il periodo e la scala; col mouse sopra, il punto preciso (vedi hover).
    private func addSparkTips() {
        if single == nil { for (i, b) in bars.enumerated() { if let pts = b.spark, let a = pts.first, let z = pts.last, pts.count >= 2 {
            let tip = "\(b.label): da \(hhmmText(a.t)) a \(hhmmText(z.t)), scala 0–\(b.scaleMax == 100 ? "100%" : "2×")\(b.mark != nil && b.scaleMax != 100 ? ", tacca a 1×" : ""). Passa il mouse sul grafico per leggere ogni punto." as NSString
            tipStrings.append(tip)   // addToolTip non trattiene l'owner: senza questo il tooltip legge memoria liberata (SIGSEGV)
            addToolTip(sparkRect(i), owner: tip, userData: nil)
        } } }
    }
    static let vColW: CGFloat = 13, vGap: CGFloat = 5
    var sparkX0: CGFloat { Self.sparkX }
    var noteX0: CGFloat { Self.noteX }
    var labelX0: CGFloat { Self.labelX }
    var valueX0: CGFloat { Self.valueX }
    // compactW: la card a metà larghezza della griglia degli account. Stesse barre, stesso grafico col mouse;
    // la nota (azzera, libera tra) va accanto all'etichetta, la barra e il grafico sotto.
    let compactW: CGFloat?
    var url: String?
    override func mouseUp(with e: NSEvent) {
        guard let u = url, let link = URL(string: u) else { return super.mouseUp(with: e) }
        enclosingMenuItem?.menu?.cancelTracking()
        NSWorkspace.shared.open(link)
    }
    static let cRowH: CGFloat = 32
    static let shortLabels = ["Settimana": "Sett."]
    // barra della card: il 42% della larghezza utile, al massimo 86 come nella card larga
    func cBarW() -> CGFloat { min(86, floor((bounds.width - 20) * 0.42)) }
    func cBrakeH() -> CGFloat {
        guard let b = brake, let w = compactW else { return 0 }
        let h = (b as NSString).boundingRect(with: NSSize(width: w - 20, height: 100), options: [.usesLineFragmentOrigin], attributes: [.font: Self.brakeFont]).height
        return min(ceil(h), 42)
    }
    func cTop() -> CGFloat { brake == nil ? 27 : 27 + cBrakeH() + 4 }
    init(icon: NSImage?, name: String, caption: String?, badge: String?, badgeColor: NSColor, brake: String?, bars: [BarSpec], single: NSAttributedString?, compactW: CGFloat? = nil) {
        self.icon = icon; self.name = name; self.caption = caption; self.badge = badge; self.badgeColor = badgeColor; self.brake = brake; self.bars = bars; self.single = single
        self.compactW = compactW
        super.init(frame: NSRect(x: 0, y: 0, width: blockW, height: Self.top(brake) + Self.rowH * CGFloat(single != nil ? 1 : bars.count) + 6))
        if let w = compactW { setFrameSize(NSSize(width: w, height: cTop() + (single != nil ? 22 : Self.cRowH * CGFloat(bars.count)) + 6)) }
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
        if single == nil { applySnapshotHover() }
        addSparkTips()
    }
    // SNAPSHOT_HOVER=riga,frazione: lo snapshot disegna il mouse su un grafico, prova visiva senza prendere lo schermo
    private func applySnapshotHover() {
        guard let h = ProcessInfo.processInfo.environment["SNAPSHOT_HOVER"]?.split(separator: ","), h.count == 2, let r = Int(h[0]), let f = Double(h[1]), r < bars.count else { return }
        let sr = sparkRect(r); hover = (row: r, x: sr.minX + sr.width * CGFloat(f))
    }
    func sparkRect(_ i: Int) -> NSRect {
        if compactW != nil { let x = 10 + cBarW() + 8; return NSRect(x: x, y: cTop() + Self.cRowH * CGFloat(i) + 16, width: bounds.width - 10 - x, height: 11) }
        if vertical { let c = cardRect(i); return NSRect(x: c.minX + Self.vColW + 6, y: c.minY + 18, width: c.width - Self.vColW - 6, height: Self.cardChartH) }
        return NSRect(x: sparkX0, y: Self.top(brake) + Self.rowH * CGFloat(i) + 3, width: Self.sparkW, height: Self.sparkH)
    }
    // Mac: un riquadro per misura, affiancati; dentro nome e %, barra verticale + grafico 24 h, nota sotto
    static let cardChartH: CGFloat = 38, cardH: CGFloat = 76
    func cardRect(_ i: Int) -> NSRect {
        // lo spazio sta tra i riquadri, non dentro: l'ultimo finisce sul bordo della griglia degli account
        let n = CGFloat(max(bars.count, 1)), gap: CGFloat = 14
        let w = (bounds.width - 38 - gridPad - gap * (n - 1)) / n
        return NSRect(x: 38 + (w + gap) * CGFloat(i), y: Self.top(brake), width: w, height: Self.cardH)
    }
    var foot: String? { didSet { if vertical { resize() } } }
    private func resize() { setFrameSize(NSSize(width: bounds.width, height: Self.top(brake) + Self.cardH + (foot != nil ? 30 : 0) + 6)) }
    // Mouse sul grafico: riga e x; il disegno mette la linea verticale e al posto della nota scrive quando e quanto.
    private var hover: (row: Int, x: CGFloat)?
    private var tipStrings: [NSString] = []
    // il menu riusa le viste se si riapre entro un minuto: niente linea rimasta dall'ultima volta
    override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); if hover != nil && ProcessInfo.processInfo.environment["SNAPSHOT_HOVER"] == nil { hover = nil; needsDisplay = true } }
    override func mouseMoved(with e: NSEvent) {
        let p = convert(e.locationInWindow, from: nil)
        var h: (Int, CGFloat)? = nil
        if single == nil { for i in bars.indices where bars[i].spark?.count ?? 0 >= 2 && sparkRect(i).insetBy(dx: -3, dy: -3).contains(p) { let sr = sparkRect(i); h = (i, min(max(p.x, sr.minX), sr.maxX)) } }
        if h?.0 != hover?.row || h?.1 != hover?.x { hover = h.map { (row: $0.0, x: $0.1) }; needsDisplay = true }
    }
    override func mouseExited(with e: NSEvent) { if hover != nil { hover = nil; needsDisplay = true } }
    private func hoverPoint(_ pts: [HistoryPoint], x: CGFloat, in sr: NSRect) -> HistoryPoint {
        let t0 = pts.first!.t, t1 = pts.last!.t
        let t = t0 + Int(Double(t1 - t0) * Double((x - sr.minX) / sr.width))
        // a gradini: vale l'ultimo punto non dopo t, come la linea disegnata
        return pts.last(where: { $0.t <= t }) ?? pts[0]
    }
    static let brakeFont = NSFont.systemFont(ofSize: 10.5, weight: .medium)
    static let brakeW: CGFloat = blockW - 53 - 16
    // Il motivo del freno va a capo (al massimo due righe): troncato a metà non spiegava niente.
    static func brakeH(_ brake: String?) -> CGFloat {
        guard let b = brake else { return 0 }
        let h = (b as NSString).boundingRect(with: NSSize(width: brakeW, height: 100), options: [.usesLineFragmentOrigin], attributes: [.font: brakeFont]).height
        // due righe al massimo; un testo già diviso a capo (i lavori del PC, uno per riga) ne tiene una per pezzo
        return min(ceil(h), max(28, 14 * CGFloat(b.components(separatedBy: "\n").count) + 2))
    }
    static func top(_ brake: String?) -> CGFloat { brake == nil ? 27 : 27 + brakeH(brake) + 4 }
    required init?(coder: NSCoder) { nil }
    override var isFlipped: Bool { true }
    override func setFrameSize(_ s: NSSize) {
        let changed = s.width != frame.width
        super.setFrameSize(s)
        if changed { removeAllToolTips(); tipStrings = []; addSparkTips() }
    }
    override func draw(_ dirty: NSRect) {
        if compactW != nil { drawCompact(); return }
        let braked = brake != nil
        // con un sottomenu (il Mac: i processi) il blocco si comporta da voce: evidenza al passaggio e freccia a destra
        let sub = enclosingMenuItem?.hasSubmenu == true
        if sub && enclosingMenuItem?.isHighlighted == true {
            NSColor.selectedContentBackgroundColor.withAlphaComponent(0.22).setFill()
            NSBezierPath(roundedRect: bounds.insetBy(dx: 5, dy: 1), xRadius: 5, yRadius: 5).fill()
        }
        if sub, let ch = NSImage(systemSymbolName: "chevron.right", accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 10, weight: .semibold)) {
            ch.isTemplate = true
            let tinted = NSImage(size: ch.size, flipped: false) { r in ch.draw(in: r); NSColor.secondaryLabelColor.set(); r.fill(using: .sourceAtop); return true }
            tinted.draw(in: NSRect(x: bounds.width - 16, y: 9, width: ch.size.width, height: ch.size.height))
        }
        let badgeShift: CGFloat = sub ? 12 : 0
        // Il blocco frenato ha una striscia arancione a sinistra: si vede chi è fermo senza leggere.
        if braked { badgeColor.setFill(); NSBezierPath(roundedRect: NSRect(x: 6, y: 5, width: 3, height: bounds.height - 9), xRadius: 1.5, yRadius: 1.5).fill() }
        icon?.draw(in: NSRect(x: 14, y: 6, width: 15, height: 15), from: .zero, operation: .sourceOver, fraction: 1)
        let nameAttr: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 12.5, weight: .semibold), .foregroundColor: NSColor.labelColor]
        (name as NSString).draw(at: NSPoint(x: 38, y: 5), withAttributes: nameAttr)
        if let cap = caption {
            let x = 38 + (name as NSString).size(withAttributes: nameAttr).width + 8
            (cap as NSString).draw(at: NSPoint(x: x, y: 7.5), withAttributes: [.font: NSFont.systemFont(ofSize: 10), .foregroundColor: NSColor.tertiaryLabelColor])
        }
        if let b = badge {
            let attr: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 10.5, weight: .semibold), .foregroundColor: badgeColor]
            let sz = (b as NSString).size(withAttributes: attr)
            let r = NSRect(x: bounds.width - 16 - sz.width - 14 - badgeShift, y: 5, width: sz.width + 14, height: 17)
            badgeColor.withAlphaComponent(0.18).setFill()
            NSBezierPath(roundedRect: r, xRadius: 8.5, yRadius: 8.5).fill()
            (b as NSString).draw(at: NSPoint(x: r.minX + 7, y: r.minY + 2), withAttributes: attr)
        }
        if let br = brake {
            let attr: [NSAttributedString.Key: Any] = [.font: Self.brakeFont, .foregroundColor: badgeColor]
            if let pause = NSImage(systemSymbolName: badge == "dato vecchio" ? "clock.fill" : "pause.circle.fill", accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 10, weight: .semibold).applying(.init(paletteColors: [badgeColor]))) {
                pause.draw(in: NSRect(x: 38, y: 26.5, width: 11, height: 11))
            }
            (br as NSString).draw(with: NSRect(x: 53, y: 25, width: Self.brakeW, height: Self.brakeH(br)), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attr)
        }
        let y0 = Self.top(brake)
        if let one = single { one.draw(at: NSPoint(x: 38, y: y0 + 2)); return }
        if vertical { drawCards(); return }
        for (i, bar) in bars.enumerated() {
            let y = y0 + Self.rowH * CGFloat(i)
            (bar.label as NSString).draw(at: NSPoint(x: labelX0, y: y + 2), withAttributes: [.font: NSFont.systemFont(ofSize: 10.5), .foregroundColor: NSColor.secondaryLabelColor])
            let ty = y + 7.5
            NSColor.labelColor.withAlphaComponent(0.12).setFill()
            NSBezierPath(roundedRect: NSRect(x: Self.barX, y: ty, width: Self.barW, height: Self.barH), xRadius: 3, yRadius: 3).fill()
            let fw = max(min(Self.barW * CGFloat(bar.frac), Self.barW), bar.frac > 0 ? 6 : 0)
            if fw > 0 { bar.color.setFill(); NSBezierPath(roundedRect: NSRect(x: Self.barX, y: ty, width: fw, height: Self.barH), xRadius: 3, yRadius: 3).fill() }
            if let m = bar.mark { NSColor.labelColor.setFill(); NSRect(x: Self.barX + Self.barW * CGFloat(min(max(m, 0), 1)) - 1, y: ty - 2.5, width: 2, height: Self.barH + 5).fill() }
            (bar.value as NSString).draw(at: NSPoint(x: valueX0, y: y + 1), withAttributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 11.5, weight: .bold), .foregroundColor: bar.color])
            if let pts = bar.spark, pts.count >= 2 { drawSpark(pts, rect: NSRect(x: sparkX0, y: y + 3, width: Self.sparkW, height: Self.sparkH), color: bar.color, scaleMax: bar.scaleMax) }
            if let h = hover, h.row == i, let pts = bar.spark, pts.count >= 2 {
                let hp = hoverPoint(pts, x: h.x, in: sparkRect(i))
                NSColor.labelColor.withAlphaComponent(0.7).setFill()
                NSRect(x: h.x - 0.5, y: y + 1, width: 1, height: Self.sparkH + 4).fill()
                let v = bar.scaleMax == 100 ? "\(Int(hp.v.rounded()))%" : String(format: "%.1f×", hp.v).replacingOccurrences(of: ".", with: ",")
                ("\(hhmmText(hp.t)) · \(v)" as NSString).draw(at: NSPoint(x: noteX0, y: y + 1.5), withAttributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 10.5, weight: .semibold), .foregroundColor: NSColor.labelColor])
            } else {
                (bar.note as NSString).draw(at: NSPoint(x: noteX0, y: y + 2), withAttributes: [.font: NSFont.systemFont(ofSize: 10.5), .foregroundColor: NSColor.secondaryLabelColor])
            }
        }
    }
    private func drawCompact() {
        let W = bounds.width
        // fondo leggero: le card affiancate si leggono come blocchi separati
        NSColor.labelColor.withAlphaComponent(0.045).setFill()
        NSBezierPath(roundedRect: bounds.insetBy(dx: 0, dy: 1), xRadius: 7, yRadius: 7).fill()
        if brake != nil { badgeColor.setFill(); NSBezierPath(roundedRect: NSRect(x: 0, y: 1, width: 3, height: bounds.height - 2), xRadius: 1.5, yRadius: 1.5).fill() }
        icon?.draw(in: NSRect(x: 10, y: 7, width: 13, height: 13), from: .zero, operation: .sourceOver, fraction: 1)
        var right = W - 8
        if badge == "libero" {
            badgeColor.setFill(); NSBezierPath(ovalIn: NSRect(x: right - 7, y: 10, width: 6, height: 6)).fill(); right -= 13
        } else if let b = badge {
            let attr: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 10, weight: .semibold), .foregroundColor: badgeColor]
            // il badge del freno dice già l'ora nella riga sotto: nella card basta la parola
            let t = (b.components(separatedBy: " fino").first ?? b) as NSString
            let sz = t.size(withAttributes: attr)
            let r = NSRect(x: right - sz.width - 12, y: 5, width: sz.width + 12, height: 16)
            badgeColor.withAlphaComponent(0.18).setFill(); NSBezierPath(roundedRect: r, xRadius: 8, yRadius: 8).fill()
            t.draw(at: NSPoint(x: r.minX + 6, y: r.minY + 1.5), withAttributes: attr)
            right = r.minX - 6
        }
        (name as NSString).draw(with: NSRect(x: 28, y: 5, width: right - 28, height: 16), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
                                attributes: [.font: NSFont.systemFont(ofSize: 12, weight: .semibold), .foregroundColor: NSColor.labelColor])
        if let br = brake {
            (br as NSString).draw(with: NSRect(x: 10, y: 25, width: W - 20, height: cBrakeH()), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
                                  attributes: [.font: Self.brakeFont, .foregroundColor: badgeColor])
        }
        let y0 = cTop()
        if let one = single { one.draw(at: NSPoint(x: 10, y: y0 + 1)); return }
        let small: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 10), .foregroundColor: NSColor.tertiaryLabelColor]
        for (i, bar) in bars.enumerated() {
            let y = y0 + Self.cRowH * CGFloat(i)
            let la: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 10.5), .foregroundColor: NSColor.secondaryLabelColor]
            let label = (Self.shortLabels[bar.label] ?? bar.label) as NSString
            label.draw(at: NSPoint(x: 10, y: y + 1), withAttributes: la)
            let va: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedDigitSystemFont(ofSize: 11.5, weight: .bold), .foregroundColor: bar.color]
            let vs = bar.value as NSString, vw = vs.size(withAttributes: va).width
            vs.draw(at: NSPoint(x: W - 10 - vw, y: y), withAttributes: va)
            // la nota tra etichetta e numero; col mouse sul grafico diventa «quando · quanto»
            let lx = 10 + label.size(withAttributes: la).width + 6
            var note = bar.note, na = small
            let sr = sparkRect(i)
            if let hv = hover, hv.row == i, let pts = bar.spark, pts.count >= 2 {
                let hp = hoverPoint(pts, x: hv.x, in: sr)
                NSColor.labelColor.withAlphaComponent(0.7).setFill(); NSRect(x: hv.x - 0.5, y: sr.minY - 2, width: 1, height: sr.height + 4).fill()
                let v = bar.scaleMax == 100 ? "\(Int(hp.v.rounded()))%" : String(format: "%.1f×", hp.v).replacingOccurrences(of: ".", with: ",")
                note = "\(hhmmText(hp.t)) · \(v)"; na = [.font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .semibold), .foregroundColor: NSColor.labelColor]
            }
            (note as NSString).draw(with: NSRect(x: lx, y: y + 2, width: max(0, W - 16 - vw - lx), height: 14), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: na)
            let ty = y + 19
            NSColor.labelColor.withAlphaComponent(0.12).setFill()
            let bw = cBarW()
            NSBezierPath(roundedRect: NSRect(x: 10, y: ty, width: bw, height: 5), xRadius: 2.5, yRadius: 2.5).fill()
            let fw = max(min(bw * CGFloat(bar.frac), bw), bar.frac > 0 ? 5 : 0)
            if fw > 0 { bar.color.setFill(); NSBezierPath(roundedRect: NSRect(x: 10, y: ty, width: fw, height: 5), xRadius: 2.5, yRadius: 2.5).fill() }
            if let m = bar.mark { NSColor.labelColor.setFill(); NSRect(x: 10 + bw * CGFloat(min(max(m, 0), 1)) - 1, y: ty - 2, width: 2, height: 9).fill() }
            if let pts = bar.spark, pts.count >= 2 { drawSpark(pts, rect: sr, color: bar.color, scaleMax: bar.scaleMax) }
        }
    }
    private func drawCards() {
        let small: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 10.5), .foregroundColor: NSColor.secondaryLabelColor]
        for (i, bar) in bars.enumerated() {
            let c = cardRect(i), sr = sparkRect(i), inner = sr.maxX - c.minX
            (bar.label as NSString).draw(at: NSPoint(x: c.minX, y: c.minY + 1), withAttributes: [.font: NSFont.systemFont(ofSize: 11, weight: .medium), .foregroundColor: NSColor.labelColor])
            let va: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedDigitSystemFont(ofSize: 11.5, weight: .bold), .foregroundColor: bar.color]
            let vs = bar.value as NSString
            vs.draw(at: NSPoint(x: c.minX + inner - vs.size(withAttributes: va).width, y: c.minY), withAttributes: va)
            // barra verticale alta quanto il grafico: livello di adesso a sinistra, com'è andata nelle 24 h a destra
            let bx = c.minX, top = sr.minY, h = sr.height
            NSColor.labelColor.withAlphaComponent(0.12).setFill()
            NSBezierPath(roundedRect: NSRect(x: bx, y: top, width: Self.vColW, height: h), xRadius: 3, yRadius: 3).fill()
            let fh = max(min(h * CGFloat(bar.frac), h), bar.frac > 0 ? 3 : 0)
            if fh > 0 { bar.color.setFill(); NSBezierPath(roundedRect: NSRect(x: bx, y: top + h - fh, width: Self.vColW, height: fh), xRadius: 3, yRadius: 3).fill() }
            if let m = bar.mark { NSColor.labelColor.setFill(); NSRect(x: bx - 2, y: top + h * CGFloat(1 - min(max(m, 0), 1)) - 1, width: Self.vColW + 4, height: 2).fill() }
            if let pts = bar.spark, pts.count >= 2 { drawSpark(pts, rect: sr, color: bar.color, scaleMax: bar.scaleMax) }
            else { NSColor.labelColor.withAlphaComponent(0.05).setFill(); NSBezierPath(roundedRect: sr, xRadius: 3, yRadius: 3).fill() }
            var note = bar.note, na = small
            if let hv = hover, hv.row == i, let pts = bar.spark, pts.count >= 2 {
                let hp = hoverPoint(pts, x: hv.x, in: sr)
                NSColor.labelColor.withAlphaComponent(0.7).setFill(); NSRect(x: hv.x - 0.5, y: sr.minY - 1, width: 1, height: sr.height + 2).fill()
                note = "\(hhmmText(hp.t)) · \(Int(hp.v.rounded()))%"; na = [.font: NSFont.monospacedDigitSystemFont(ofSize: 10.5, weight: .semibold), .foregroundColor: NSColor.labelColor]
            }
            (note as NSString).draw(with: NSRect(x: c.minX, y: sr.maxY + 3, width: inner, height: 14), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: na)
        }
        if let f = foot {
            let y = Self.top(brake) + Self.cardH + 2
            NSColor.separatorColor.setFill(); NSRect(x: 38, y: y, width: bounds.width - 38 - gridPad, height: 1).fill()
            (f as NSString).draw(with: NSRect(x: 38, y: y + 5, width: bounds.width - 38 - gridPad, height: 26), options: [.usesLineFragmentOrigin], attributes: small)
        }
    }
    // Area + linea a gradini sulla scala piena (0…100%, o 0…2× per il ritmo): niente zoom che esageri le salite.
    // Un buco lungo nei dati spezza la linea invece di inventare un tratto.
    private func drawSpark(_ pts: [HistoryPoint], rect r: NSRect, color: NSColor, scaleMax: Double) {
        NSColor.labelColor.withAlphaComponent(0.05).setFill()
        NSBezierPath(roundedRect: r.insetBy(dx: -2, dy: -1), xRadius: 3, yRadius: 3).fill()
        guard let t0 = pts.first?.t, let t1 = pts.last?.t, t1 > t0 else { return }
        let gap = max(1800, (t1 - t0) / 6)
        func pt(_ p: HistoryPoint) -> NSPoint {
            NSPoint(x: r.minX + r.width * CGFloat(p.t - t0) / CGFloat(t1 - t0),
                    y: r.maxY - r.height * CGFloat(min(max(p.v, 0), scaleMax) / scaleMax))
        }
        var runs: [[HistoryPoint]] = [[pts[0]]]
        for (a, b) in zip(pts, pts.dropFirst()) { if b.t - a.t > gap { runs.append([b]) } else { runs[runs.count - 1].append(b) } }
        for run in runs where run.count >= 2 {
            let line = NSBezierPath(), area = NSBezierPath()
            area.move(to: NSPoint(x: pt(run[0]).x, y: r.maxY))
            for (i, p) in run.enumerated() {
                let q = pt(p)
                if i == 0 { line.move(to: q); area.line(to: q) } else {
                    let prev = pt(run[i - 1])
                    line.line(to: NSPoint(x: q.x, y: prev.y)); line.line(to: q)
                    area.line(to: NSPoint(x: q.x, y: prev.y)); area.line(to: q)
                }
            }
            area.line(to: NSPoint(x: pt(run[run.count - 1]).x, y: r.maxY)); area.close()
            color.withAlphaComponent(0.18).setFill(); area.fill()
            color.setStroke(); line.lineWidth = 1.2; line.stroke()
        }
        // L'ultimo valore come punto: è il numero scritto a sinistra.
        let last = pt(pts[pts.count - 1])
        color.setFill(); NSBezierPath(ovalIn: NSRect(x: last.x - 2, y: last.y - 2, width: 4, height: 4)).fill()
    }
}

// Le card degli account affiancate: tre colonne, le card di una riga alte uguali. La griglia prende la larghezza vera
// del menu (AppKit allarga le viste con .width), margini uguali ai due lati; una card rimasta sola occupa tutta la riga.
let gridPad: CGFloat = 14, gridGap: CGFloat = 8
let gridCols = 3
let gridColW: CGFloat = (blockW - 2 * gridPad - gridGap * CGFloat(gridCols - 1)) / CGFloat(gridCols)
final class GridView: NSView {
    override var isFlipped: Bool { true }
    private let cards: [NSView], cols: Int
    init(_ views: [NSView], cols: Int = gridCols) {
        cards = views; self.cols = cols
        var y: CGFloat = 3
        for start in stride(from: 0, to: views.count, by: cols) { y += (views[start..<min(start + cols, views.count)].map { $0.frame.height }.max() ?? 0) + gridGap }
        super.init(frame: NSRect(x: 0, y: 0, width: blockW, height: y - gridGap + 4))
        autoresizingMask = [.width]
        views.forEach { addSubview($0) }
        place()
    }
    required init?(coder: NSCoder) { nil }
    override func resizeSubviews(withOldSize old: NSSize) { place() }
    private func place() {
        let inner = bounds.width - 2 * gridPad
        var y: CGFloat = 3
        for start in stride(from: 0, to: cards.count, by: cols) {
            let row = Array(cards[start..<min(start + cols, cards.count)])
            let h = row.map { $0.frame.height }.max() ?? 0
            let w = (inner - gridGap * CGFloat(row.count - 1)) / CGFloat(row.count)
            for (j, v) in row.enumerated() { v.frame = NSRect(x: gridPad + CGFloat(j) * (w + gridGap), y: y, width: w, height: h); v.needsDisplay = true }
            y += h + gridGap
        }
    }
}

func inText(_ epoch: Int, now: Date = Date()) -> String {
    let s = max(Double(epoch) - now.timeIntervalSince1970, 0)
    return s >= 86400 ? "\(Int(s / 86400)) g \(Int(s.truncatingRemainder(dividingBy: 86400) / 3600)) h" : s >= 3600 ? "\(Int(s / 3600)) h \(Int(s.truncatingRemainder(dividingBy: 3600) / 60)) min" : "\(Int(s / 60)) min"
}
let barText = NSFont.systemFont(ofSize: 10.5)
func two(_ strong: String, _ rest: String, _ tone: NSColor = .labelColor) -> NSAttributedString {
    let a = NSMutableAttributedString(string: strong, attributes: [.font: NSFont.systemFont(ofSize: 10.5, weight: .semibold), .foregroundColor: tone])
    a.append(NSAttributedString(string: rest, attributes: [.font: barText, .foregroundColor: NSColor.secondaryLabelColor]))
    return a
}
func paceTone(_ ratio: Double) -> NSColor { ratio > 1.3 ? toneBad : ratio > 1.0 ? toneWarn : toneOK }

// Motivo del freno per questo account: il hub li unisce per provider («claude/a: …; claude/b: …»).
func accountWait(_ p: Provider, _ a: Account) -> AccountWait? {
    guard let st = liveGates?.providers?[p.id], st.state == "frenato" else { return nil }
    return st.accounts?.first { $0.account == a.label }
}
// Perché aspetta e a quale condizione riparte, detto per esteso: «frenato» da solo non dice cosa sbloccherà.
func resumeText(_ w: AccountWait) -> String {
    let at = w.until.map { hhmmText(Int($0 / 1000)) } ?? "?"
    let t = Int((w.target ?? 0).rounded())
    switch w.kind {
    case "5h": return "Finestra di 5 ore piena: il differibile riparte alle \(at), quando si libera"
    case "riserva": return "Sotto il \(t)% la quota resta per le tue sessioni: il differibile riparte al reset, \(at)"
    case "ritmo": return "Più veloce del ritmo della settimana: riparte alle \(at), quando il tempo trascorso arriva al \(t)% già usato (se non si consuma altro)"
    case "giorno": return "Ultime 24 ore oltre \(String(format: "%.1f", w.target ?? 0).replacingOccurrences(of: ".", with: ","))% al giorno: riparte alle \(at), quando quel consumo esce dalle 24 ore"
    default: return "Il differibile aspetta: \(w.why)"
    }
}

func accountBlock(_ p: Provider, _ a: Account, renewal: Renewal? = nil, credit: CloudCredit? = nil, now: Date = Date(), compactW: CGFloat? = nil) -> NSMenuItem? {
    guard let w = a.quotas.first(where: { $0.key.lowercased() == "7d" }) else { return nil }
    let name = "\(p.name) · \(shortLabel(a.label))"
    let icon = providerSym(p.id, pt: 14, color: .labelColor)
    // Accanto al nome, in piccolo: quanto costa, quando rinnova, reset manuali ancora disponibili (Codex).
    var capParts: [String] = []
    if let r = renewal { capParts.append(r.amount + (r.cycle == "mensile" ? "/mese" : r.cycle == "annuale" ? "/anno" : "")); if let d = r.renewsAt { capParts.append("rinnovo " + dayMonth(d)) } }
    if let n = a.resetCredits?.available, n > 0 { capParts.append("\(n) reset manual\(n == 1 ? "e" : "i")") }
    let caption = capParts.isEmpty ? nil : capParts.joined(separator: " · ")
    let tip = "Settimana: quanta quota hai usato; la tacca è dove dovresti essere consumando in modo uniforme. 5 ore: la finestra breve. Oggi: le ultime 24 ore contro la quota giornaliera sostenibile (quello che resta ÷ giorni al reset), tacca a 1×; oltre, il lavoro rimandabile aspetta. Il grafico accanto al numero è l'andamento della stessa misura."
    func make(_ badge: String?, _ bc: NSColor, _ brake: String?, _ bars: [BarSpec], _ single: NSAttributedString?) -> NSMenuItem {
        let it = NSMenuItem()
        let v = AccountBlockView(icon: icon, name: name, caption: caption, badge: badge, badgeColor: bc, brake: brake, bars: bars, single: single, compactW: compactW)
        v.url = serviceURL[p.id]
        // nella card il prezzo e il rinnovo non ci stanno accanto al nome: vanno nel suggerimento
        var t = compactW != nil && caption != nil ? caption! + "\n" + tip : tip
        if v.url != nil { t += "\n\nClic: apre la pagina dei consumi di \(p.name) (nel browser, con l'account che vi è collegato)" }
        v.toolTip = t; it.view = v; it.toolTip = t
        return it
    }
    // esaurito: si tengono le barre, così restano in vista il reset, il bonus e i modelli con quota propria
    let empty = w.usedPct >= 100
    let gate = liveGates?.providers?[p.id]
    let wait = accountWait(p, a)
    // Frenato = questo account ha un motivo suo nel freno; il provider frenato per un altro account non lo colora.
    // L'ora è la sua: con quella del provider la riserva di zorahrel (fino a domenica) diceva «08:52».
    let braked = wait != nil
    let until = wait?.until.map { Int($0 / 1000) }
    // Dato vecchio (Muse dal 21/10 spesso non manda la quota): si dice in chiaro, invece di un grigio senza spiegazione
    let old = w.status == "stale"
    let badge: String? = empty ? "esaurito" : braked ? "frenato" + (until.map { " fino alle " + hhmmText($0) } ?? "") : old ? "dato vecchio" : gate != nil ? "libero" : nil
    let bcol: NSColor = empty ? toneBad : braked ? toneWarn : old ? .secondaryLabelColor : toneOK
    let brakeLine = wait.map(resumeText) ?? (old ? "\(p.name) adesso non manda la quota: questa è l'ultima lettura (\(w.resetText)), il freno usa lei" : nil)
    var bars: [BarSpec] = []
    var expected: Double?
    if let r = w.resetsAt { expected = min(max(1 - (Double(r) - now.timeIntervalSince1970) / (7 * 86400), 0), 1) * 100 }
    let ratio = (expected ?? 0) >= 5 ? Double(w.usedPct) / expected! : 0
    let wtone = paceTone(ratio)
    bars.append(BarSpec(label: "Settimana", frac: Double(w.usedPct) / 100, mark: expected.map { $0 / 100 }, color: old ? .secondaryLabelColor : wtone,
                        value: "\(w.usedPct)%", spark: w.history, note: w.resetsAt.map { (empty ? "torna " : "azzera ") + resetText($0) } ?? w.resetText))
    if TrayPrefs.showDaily, let f = a.quotas.first(where: { $0.key.lowercased() == "5h" }) {
        let tone: NSColor = f.usedPct >= 95 ? toneBad : f.usedPct >= 80 ? toneWarn : toneOK
        bars.append(BarSpec(label: "5 ore", frac: Double(f.usedPct) / 100, mark: nil, color: tone,
                            value: "\(f.usedPct)%", spark: f.history, note: f.resetsAt.map { "libera tra " + inText($0) } ?? ""))
    }
    // Oggi: un indicatore, non una frase. Scala 0…2×, tacca a 1× = la quota giornaliera sostenibile.
    if let t = liveHeavy?.today.first(where: { $0.provider == p.id && $0.account == a.label }), t.perDay > 0 {
        let x = t.last24h / t.perDay
        let tone: NSColor = x > 1 ? toneBad : x > 0.8 ? toneWarn : toneOK
        bars.append(BarSpec(label: "Oggi", frac: min(x / 2, 1), mark: 0.5, color: tone,
                            value: timesShort(x), spark: nil, note: "\(pctShort(t.last24h)) in 24 h · ok \(pctShort(t.perDay))"))
    }
    if TrayPrefs.showBonus, let c = credit, c.nobonus != true, let left = c.remaining, let lim = c.limit, lim > 0 {
        let used = c.used ?? lim - left
        let pct = Int((used / lim * 100).rounded())
        let tone: NSColor = pct >= 95 ? toneBad : pct >= 80 ? toneWarn : toneOK
        bars.append(BarSpec(label: "Bonus", frac: used / lim, mark: nil, color: tone, value: money(left, decimals: 0),
                            spark: nil, note: "rimasti" + (c.renewsAt.map { " · scade " + dayMonth($0) } ?? "")))
    }
    for m in credit?.models ?? [] {
        let pct = m.pct ?? 0
        let tone: NSColor = pct >= 95 ? toneBad : pct >= 80 ? toneWarn : toneOK
        let reset = m.resets.flatMap { ISO8601DateFormatter().date(from: $0.replacingOccurrences(of: #"\.\d+"#, with: "", options: .regularExpression)) }
        bars.append(BarSpec(label: m.name, frac: pct / 100, mark: nil, color: tone, value: "\(Int(pct.rounded()))%",
                            spark: nil, note: "quota sua" + (reset.map { " · azzera " + resetText(Int($0.timeIntervalSince1970)) } ?? "")))
    }
    if TrayPrefs.showApi, let api = a.apiSpend {
        let tone = api.status == "unknown" ? NSColor.secondaryLabelColor : statusColor(api.status)
        bars.append(BarSpec(label: "API", frac: Double(api.usedPct) / 100, mark: nil, color: tone,
                            value: api.detail?.components(separatedBy: " ").first ?? "\(api.usedPct)%", spark: api.history,
                            note: api.resetsAt.map { "scade " + dayMonthEpoch($0) } ?? "credito"))
    }
    return make(badge, bcol, brakeLine, bars, nil)
}

// Pagina dei consumi del servizio (Codex: link «usage dashboard» di developers.openai.com/codex/pricing). Muse non ne ha una nota, niente link inventati
let serviceURL: [String: String] = ["claude": "https://claude.ai/settings/usage", "codex": "https://chatgpt.com/codex/settings/usage"]

func hhmmText(_ epoch: Int) -> String {
    let f = DateFormatter(); f.locale = Locale(identifier: "it_IT")
    f.dateFormat = Calendar.current.isDateInToday(Date(timeIntervalSince1970: TimeInterval(epoch))) ? "HH:mm" : "EEE HH:mm"
    return f.string(from: Date(timeIntervalSince1970: TimeInterval(epoch)))
}

func providerRow(_ p: Provider, now: Date = Date()) -> NSMenuItem {
    richRow(icon: providerSym(p.id), txt(providerSummary(p, now: now)))
}

// MARK: progetti

let projTabs: [CGFloat] = [235, 290, 345, 505]
let blankIcon: NSImage = NSImage(size: NSSize(width: 13, height: 13))
func projectsHead() -> NSMenuItem {
    let f = NSFont.systemFont(ofSize: 10, weight: .semibold), f2 = NSFont.systemFont(ofSize: 9.5)
    let head = NSMutableAttributedString(attributedString: txt("PROGETTO", f, .secondaryLabelColor))
    for t in ["Claude", "Codex", "Muse", "stato"] { head.append(txt("\t" + t, f, .secondaryLabelColor)) }
    head.append(txt("\n"))
    head.append(txt("\t% sett.\t% sett.\t% sett.\tagenti vivi o da quanto è fermo", f2, .tertiaryLabelColor))
    let it = richRow(icon: nil, head, tabs: projTabs); it.isEnabled = false
    return it
}
func durText(_ ms: Double) -> String {
    let m = Int(ms / 60000)
    if m < 1 { return "meno di 1 min" }
    if m < 60 { return "\(m) min" }
    let h = m / 60, r = m % 60
    return r == 0 || h >= 10 ? "\(h) h" : "\(h) h \(r) min"
}
func agoText(_ epochMs: Double) -> String {
    let d = Date().timeIntervalSince1970 * 1000 - epochMs
    return d < 60000 ? "ora" : durText(d) + " fa"
}
func queuedCount(_ name: String) -> Int {
    let names = Set([name] + (liveProjects.first { $0.name == name }?.members ?? []))
    return liveQueue.filter { names.contains($0.project) && ($0.status == "queued" || $0.status == "running") }.count }
func agentCount(_ pr: LiveProject) -> Int { pr.agents?.count ?? 0 }
func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }
func dayText(_ ms: Double) -> String {
    let f = DateFormatter(); f.locale = Locale(identifier: "it_IT"); f.dateFormat = "d/M"
    return f.string(from: Date(timeIntervalSince1970: ms / 1000))
}
func idleText(_ ms: Double) -> String { ms >= 86400000 ? "\(Int(ms / 86400000)) g" : durText(ms) }
func provName(_ id: String) -> String { id == "codex" ? "Codex" : id == "muse" ? "Muse" : id == "claude" ? "Claude" : id }
// Stato del progetto a parole: chi lavora, chi è frenato, chi aspetta, da quanto è fermo.
func stateWords(_ pr: LiveProject) -> (String, String, NSColor) {
    let n = agentCount(pr), q = queuedCount(pr.name)
    if pr.state == "frenato" { return ("pause.circle", n > 0 ? "frenato · \(n) \(n == 1 ? "agente" : "agenti")" : "frenato", toneWarn) }
    if n > 0 { return ("play.circle", "\(n) \(n == 1 ? "agente" : "agenti") al lavoro", toneOK) }
    if q > 0 { return ("clock", "in coda \(q)", NSColor.systemBlue) }
    if let l = pr.lastSeen { return ("moon", "fermo da " + idleText(nowMs() - l.at), NSColor.secondaryLabelColor) }
    return ("moon", "fermo", NSColor.secondaryLabelColor)
}
// «codex/a@x: finestra 5h al 100%; claude/b@y: …» → «aspetta Codex a, Claude b»: il motivo per account sta già nel suo blocco.
func brakeWho(_ why: String) -> String? {
    if why.isEmpty { return nil }
    let who = why.components(separatedBy: "; ").compactMap { seg -> String? in
        guard let head = seg.split(separator: ":", maxSplits: 1).first, head.contains("/") else { return nil }
        let pa = head.split(separator: "/", maxSplits: 1)
        return provName(String(pa[0])) + " " + shortLabel(String(pa[1]))
    }
    return who.isEmpty ? why : "aspetta " + who.joined(separator: ", ")
}
// Il perché di «fermo» in una frase: da quanto, cosa è successo l'ultima volta, e se manca la cartella.
func idleReason(_ pr: LiveProject) -> String? {
    if agentCount(pr) > 0 { return nil }
    if pr.state == "frenato" { return "frenato: " + (pr.budgetPct.map { pr.claude >= $0 } == true ? "il budget Claude (\(Int(pr.budgetPct ?? 0))% della settimana) è finito" : (pr.why.flatMap { brakeWho($0) } ?? "i lavori rimandabili aspettano un abbonamento libero")) }
    let q = queuedCount(pr.name)
    if q > 0 { return "in coda: \(q) \(q == 1 ? "lavoro aspetta" : "lavori aspettano") un abbonamento libero" + (pr.why.flatMap { $0.isEmpty ? nil : " (" + $0 + ")" } ?? "") }
    var s = "fermo: nessun agente al lavoro"
    if let l = pr.lastSeen { s += " da \(idleText(nowMs() - l.at)), ultima attività il \(dayText(l.at)) (\(provName(l.provider)))" } else { s += " da oltre 7 giorni" }
    if pr.dirMissing == true { s += " · la cartella dove lavorava era temporanea e non esiste più" }
    return s
}
// «2 Opus · 1 Muse» con l'icona dell'abbonamento davanti a ogni gruppo.
func agentMix(_ a: AgentSummary) -> NSAttributedString {
    let out = NSMutableAttributedString()
    for (i, m) in a.models.enumerated() {
        if i > 0 { out.append(txt("  ·  ", rowSmall, .tertiaryLabelColor)) }
        out.append(inlineIcon(m.provider, provider: true))
        out.append(txt(" \(m.n) \(m.model)", rowSmall, .secondaryLabelColor))
    }
    return out
}
func opusWarning(_ pr: LiveProject) -> String? {
    guard let a = pr.agents, a.opus > 0, pr.claude >= 10 || a.opusMs >= 2 * 3600000 else { return nil }
    return "\(a.opus) \(a.opus == 1 ? "sessione Opus" : "sessioni Opus") da \(durText(a.opusMs)) su un progetto che pesa il \(pctShort(pr.claude)) della settimana Claude: valuta Sonnet"
}
func projectSubmenu(_ pr: LiveProject, actionTarget: AnyObject?) -> NSMenu {
    let ps = NSMenu(); ps.autoenablesItems = false
    let (ic, words, tone) = stateWords(pr)
    ps.addItem(richRow(icon: sym(ic, color: tone), txt(pr.title ?? pr.name, rowBold), detail: [pr.what, idleReason(pr) ?? words].compactMap { $0 }.joined(separator: " · "), wrap: 70))
    if let w = opusWarning(pr) {
        ps.addItem(richRow(icon: sym("exclamationmark.triangle", color: toneWarn), txt(wrapText(w, 64), rowSmall, toneWarn)))
    }
    ps.addItem(.separator())
    let tabs: [CGFloat] = [145, 235, 315, 455]   // a destra; oltre ~460 il menu taglia, sotto 85 di passo «meno di 1 min» tocca il tipo
    if let a = pr.agents, !a.list.isEmpty {
        ps.addItem(headRow(["AGENTI VIVI ADESSO", "tipo", "da", "ultima attività", "CPU · memoria"], tabs: tabs))
        for g in a.list {
            // un sottoagente sta rientrato sotto la sessione che l'ha lanciato, un agente di workflow un gradino più in là
            let d = g.depth ?? 0
            let l = NSMutableAttributedString(attributedString: txt(d > 0 ? String(repeating: "   ", count: d - 1) + "↳ " + g.model : g.model, d > 0 ? rowFont : rowBold))
            for c in [g.kind, durText(nowMs() - g.startedAt), agoText(g.lastActivity), g.res.map(resText) ?? "–"] { l.append(txt("\t" + c, rowNum, .secondaryLabelColor)) }
            let row = richRow(icon: providerSym(g.provider), l, detail: g.title.isEmpty ? nil : g.title, tabs: tabs,
                              tip: (g.open.map { "Clic per aprire la sessione in \($0.via)" } ?? ("Non apribile: " + (g.where ?? "gira in background"))) + (g.res.map { r in r.shared.map { " · CPU e memoria sono la somma di \($0) agenti nello stesso progetto" } ?? " · CPU e memoria dell'albero di processi di questo agente" } ?? ""), wrap: 80)
            if let o = g.open {
                row.action = #selector(AppDelegate.openLink(_:)); row.target = actionTarget
                row.representedObject = ["url": o.url, "what": "\(pr.name) · \(g.model) \(g.kind)"]
                row.image = providerSym(g.provider, color: NSColor.controlAccentColor)
            }
            ps.addItem(row)
        }
    } else {
        ps.addItem(noteRow("Nessun agente al lavoro adesso" + (pr.lastSeen.map { " · ultima attività \(agoText($0.at))" } ?? ""), icon: "moon"))
    }
    ps.addItem(.separator())
    if let chats = pr.topics, !chats.isEmpty {
        ps.addItem(.separator())
        ps.addItem(noteRow("Chat Topics di questo progetto: il lavoro si fa lì"))
        for c in chats {
            let row = richRow(icon: sym("bubble.left.and.text.bubble.right", color: NSColor.controlAccentColor), txt(c.title.isEmpty ? "chat" : c.title, rowFont), detail: c.busy ? "al lavoro adesso · clic per aprirla" : "clic per aprirla", tip: "Apre la chat in Topics")
            row.action = #selector(AppDelegate.openLink(_:)); row.target = actionTarget
            row.representedObject = ["url": c.url, "what": "\(pr.name) · chat Topics"]
            ps.addItem(row)
        }
    }
    ps.addItem(.separator())
    let wl = NSMutableAttributedString(attributedString: txt("Questa settimana", rowFont))
    for (n, v) in [("Claude", pr.claude), ("Codex", pr.codex), ("Muse", pr.muse)] { wl.append(txt("\t\(n) \(pctShort(v))", rowNum, v > 0 ? .labelColor : .tertiaryLabelColor)) }
    let wtabs: [CGFloat] = [225, 315, 405]   // «Codex 23%» è largo 65: con 70 di passo toccava la colonna prima
    ps.addItem(richRow(icon: sym("calendar"), wl, detail: "% dell'abbonamento usato dai lavori di questo progetto", tabs: wtabs))
    if let h = liveHeavy?.sessions.first(where: { $0.project == pr.name }) {
        ps.addItem(richRow(icon: sym("sun.max"), txt("Oggi", rowFont), detail: "\(h.sessions) sessioni Claude · \(String(format: "%.1f", h.tokens / 1e6).replacingOccurrences(of: ".", with: ",")) M token", tabs: wtabs))
    }
    let bp = (pr.budgetPct.map { "budget \(Int($0))% Claude" } ?? "nessun budget") + " · priorità " + pr.priority
    if let j = pr.lastJob {
        ps.addItem(richRow(icon: sym(j.status == "done" ? "checkmark.circle" : "xmark.circle", color: j.status == "done" ? toneOK : toneBad), txt("Ultimo lavoro in coda", rowFont), detail: j.task + (j.endedAt.map { " · " + agoText($0) } ?? ""), wrap: 70))
    }
    // un gruppo di cartelle temporanee non ha un budget suo: si elencano i membri e basta
    if let ms = pr.members {
        ps.addItem(.separator())
        ps.addItem(noteRow("\(ms.count) cartelle in \(pr.dir ?? "?"), raccolte per cartella madre"))
        for g in pr.subgroups ?? [] {
            let l = NSMutableAttributedString(attributedString: txt(g.path, rowBold))
            l.append(txt("\t\(g.members.count) cartelle" + (g.agents > 0 ? " · \(g.agents) agenti" : ""), rowNum, .secondaryLabelColor))
            ps.addItem(richRow(icon: sym("folder"), l, detail: g.members.joined(separator: ", "), tabs: [330], wrap: 70))
        }
        return ps
    }
    ps.addItem(.separator())
    let set = NSMenu(); set.autoenablesItems = false
    set.addItem(noteRow("Budget: % della settimana Claude, oltre si ferma il non interattivo"))
    for opt in [0, 5, 10, 15, 20, 30] {
        let it = NSMenuItem(title: opt == 0 ? "Nessuno" : "\(opt)%", action: #selector(AppDelegate.setProjectBudget(_:)), keyEquivalent: "")
        it.target = actionTarget; it.representedObject = ["name": pr.name, "budget": opt]
        it.state = (pr.budgetPct.map { Int($0) } ?? 0) == opt ? .on : .off
        set.addItem(it)
    }
    set.addItem(.separator())
    set.addItem(noteRow("Priorità: alta corre di più, bassa si ferma prima"))
    for opt in ["alta", "normale", "bassa"] {
        let it = NSMenuItem(title: opt, action: #selector(AppDelegate.setProjectPriority(_:)), keyEquivalent: "")
        it.target = actionTarget; it.representedObject = ["name": pr.name, "priority": opt]
        it.image = prioritySym(opt)
        it.state = pr.priority == opt ? .on : .off
        set.addItem(it)
    }
    let sit = richRow(icon: prioritySym(pr.priority) ?? sym("slider.horizontal.3"), txt("Budget e priorità", rowFont), detail: bp)
    sit.submenu = set
    ps.addItem(sit)
    return ps
}
func projectRow(_ pr: LiveProject, actionTarget: AnyObject?, dim: Bool = false) -> NSMenuItem {
    let title = pr.title ?? pr.name
    let line = NSMutableAttributedString(attributedString: txt(title.count > 24 ? String(title.prefix(23)) + "…" : title, rowFont, dim ? .tertiaryLabelColor : .labelColor))
    for v in [pr.claude, pr.codex, pr.muse] { line.append(txt("\t" + pctShort(v), rowNum, v > 0 ? .labelColor : .tertiaryLabelColor)) }
    let (ic, words, tone) = stateWords(pr)
    line.append(txt("\t")); line.append(inlineIcon(ic, color: tone)); line.append(txt(" " + words, .systemFont(ofSize: 11, weight: .medium), tone))
    var da: NSAttributedString? = nil
    // sotto il nome: chi lavora e dove (la cartella spiega i nomi come «Y8-K31»), oppure perché è fermo
    if let a = pr.agents, !a.models.isEmpty {
        let m = NSMutableAttributedString(attributedString: agentMix(a))
        if let w = pr.what, !w.isEmpty { m.append(txt("  ·  " + (w.count > 60 ? String(w.prefix(59)) + "…" : w), rowSmall, .secondaryLabelColor)) }
        da = m
    } else {
        // «fermo da…» sta già nella colonna stato: qui la descrizione; il perché solo se frenato o in coda, dove conta
        let why = pr.state == "frenato" || queuedCount(pr.name) > 0 ? idleReason(pr) : nil
        da = txt(why ?? pr.what ?? idleReason(pr) ?? "", rowSmall, .secondaryLabelColor)
    }
    let icon: NSImage = pr.priority == "normale" ? blankIcon : (prioritySym(pr.priority) ?? blankIcon)
    var sentence = "\(title) ha usato il \(pctShort(pr.claude)) della settimana di Claude, il \(pctShort(pr.codex)) di Codex e il \(pctShort(pr.muse)) di Muse"
    sentence = sentence.replacingOccurrences(of: "il –", with: "lo 0%")
    let item = richRow(icon: icon, line, detailAttr: da, tabs: projTabs,
                       tip: "\(sentence). Stato: \(words)\(idleReason(pr).map { ". " + $0 } ?? ""). Clic per agenti, chat, consumi, budget e priorità.", wrap: 100)
    item.submenu = projectSubmenu(pr, actionTarget: actionTarget)
    return item
}
let toneRed = NSColor.systemRed
// Progetti: una voce sola; dentro chi ha agenti o è frenato in cima, poi gli altri, i morti in fondo sbiaditi.
func projectsMenuItem(actionTarget: AnyObject?) -> NSMenuItem? {
    guard !liveProjects.isEmpty else { return nil }
    let rank = { (p: LiveProject) -> Int in agentCount(p) > 0 ? 0 : p.state == "frenato" ? 1 : queuedCount(p.name) > 0 || p.state == "in coda" ? 2 : 3 }
    let alive = liveProjects.filter { $0.dead != true }.enumerated().sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }.map { $0.element }
    let all = NSMenu(); all.autoenablesItems = false
    all.addItem(projectsHead())
    for pr in alive { all.addItem(projectRow(pr, actionTarget: actionTarget)) }
    let dead = liveProjects.filter { $0.dead == true }
    if !dead.isEmpty {
        all.addItem(.separator())
        all.addItem(noteRow("Fermi da 7 giorni o con la cartella sparita"))
        for pr in dead { all.addItem(projectRow(pr, actionTarget: actionTarget, dim: true)) }
    }
    let braked = alive.filter { $0.state == "frenato" }.count
    let it = richRow(icon: sym("folder"), txt("Progetti, budget e priorità", rowFont), detail: "\(alive.count) attivi" + (braked > 0 ? " · \(braked) frenati" : ""))
    it.submenu = all
    return it
}

// MARK: chi lavora adesso: gli agenti vivi di tutti i progetti in una lista sola

let agentsShown = 5
func liveAgentRows(actionTarget: AnyObject?) -> [NSMenuItem] {
    // qui solo le sessioni: i sottoagenti stanno nel progetto, sotto chi li ha lanciati (contano nel totale)
    let everyone = liveProjects.flatMap { pr in (pr.agents?.list ?? []).map { (pr, $0) } }
    let all = everyone.filter { ($0.1.depth ?? 0) == 0 }.sorted { $0.1.lastActivity > $1.1.lastActivity }
    let subs = everyone.count - all.count
    var out: [NSMenuItem] = [headRow(all.isEmpty ? ["NESSUN AGENTE AL LAVORO"] : ["AL LAVORO ADESSO · \(all.count)" + (subs > 0 ? " + \(subs) SOTTOAGENTI" : "")], tabs: [])]
    let tabs: [CGFloat] = [300, menuTextMax]
    // Agenti uguali (stesso progetto, titolo, modello e tipo) in una riga con ×N: 23/10 i 7 Codex di un lotto in /tmp/zgen
    // erano 7 righe identiche «17 cartelle temporanee · K4-P9» e coprivano tutti gli altri progetti.
    var rows: [(pr: LiveProject, g: AgentInfo, n: Int)] = []
    for (pr, g) in all {
        if let i = rows.firstIndex(where: { $0.pr.name == pr.name && $0.g.title == g.title && $0.g.model == g.model && $0.g.kind == g.kind }) { rows[i].n += 1 }
        else { rows.append((pr, g, 1)) }
    }
    for (pr, g, n) in rows.prefix(agentsShown) {
        let name = pr.title ?? pr.name
        let line = NSMutableAttributedString(attributedString: txt(name.count > 30 ? String(name.prefix(29)) + "…" : name, rowFont))
        // a destra quanto consuma adesso (token nell'ultima ora), poi modello e da quanto; sotto il giro intero
        // provider frenato: la sessione aperta continua, ma lo si dice sulla riga invece che in un banner
        let braked = liveGates?.providers?[g.provider]?.state == "frenato"
        line.append(txt("\t" + (braked ? "frenato" : ""), rowNum, toneWarn))
        if let u = g.use, u.hourTokens > 0 { line.append(txt((braked ? " · " : "") + "\(tokText(u.hourTokens))/h", rowNum, .labelColor)) }
        line.append(txt("\t\(g.model)\(n > 1 ? " ×\(n)" : "") · \(durText(nowMs() - g.startedAt))", rowNum, .secondaryLabelColor))
        let what = [g.title.isEmpty ? nil : g.title, g.kind == "sessione" || name.lowercased().contains(g.kind) ? nil : g.kind].compactMap { $0 }.joined(separator: " · ")
        let useText = g.use.map { u in "\(tokText(u.tokens)) token nel giro" + (u.pct.map { $0 >= 0.05 ? " · " + String(format: "%.1f", $0).replacingOccurrences(of: ".", with: ",") + "% della settimana" : "" } ?? "") }
        let detail = [useText, what.isEmpty ? nil : what].compactMap { $0 }.joined(separator: " · ")
        let row = richRow(icon: providerSym(g.provider), line, detail: detail.isEmpty ? nil : detail, tabs: tabs,
                          tip: g.open.map { "Clic per aprirla in \($0.via)" } ?? "Gira in background: non si apre da qui", wrap: 70)
        if let o = g.open {
            row.action = #selector(AppDelegate.openLink(_:)); row.target = actionTarget
            row.representedObject = ["url": o.url, "what": "\(pr.name) · \(g.model) \(g.kind)"]
        }
        out.append(row)
    }
    let rest = all.count - rows.prefix(agentsShown).reduce(0) { $0 + $1.n }
    if rest > 0 { out.append(noteRow("e altri \(rest): tutti in Progetti o nella dashboard")) }
    return out
}

// Freno: stato per abbonamento e i comandi dell'hub (/api/override sblocca a tempo, /api/hold ferma i lavori nuovi).
func brakeMenuItem(actionTarget: AnyObject?) -> NSMenuItem {
    let braked = brakedProviders()
    let ov = liveGates?.overrides ?? []
    let hold = ov.first { $0.hold == true }
    let detail = braked.isEmpty ? (hold != nil ? "lavori nuovi fermi fino alle " + hhmmText(Int(hold!.until / 1000)) : "nessun freno")
        : braked.map { id in pName(id) + (liveGates?.providers?[id]?.waitUntil.map { " fino alle " + hhmmText(Int($0 / 1000)) } ?? "") }.joined(separator: " · ") + (braked.count > 1 ? " frenati" : " frenato")
    let it = richRow(icon: sym("hand.raised", color: braked.isEmpty ? nil : toneWarn), txt("Freno", rowFont), detail: detail)
    let sub = NSMenu(); sub.autoenablesItems = false
    func act(_ title: String, _ path: String, _ method: String, _ body: [String: Any]) {
        let m = NSMenuItem(title: title, action: #selector(AppDelegate.brakeAction(_:)), keyEquivalent: "")
        m.target = actionTarget; m.representedObject = ["path": path, "method": method, "body": body] as [String: Any]
        sub.addItem(m)
    }
    for id in ["claude", "codex", "muse"] {
        guard let st = liveGates?.providers?[id] else { continue }
        let until = st.waitUntil.map { " fino alle " + hhmmText(Int($0 / 1000)) } ?? ""
        sub.addItem(richRow(icon: providerSym(id), txt(pName(id), rowFont), detail: st.state == "frenato" ? "frenato\(until) · \(st.reason)" : st.state, enabled: false, wrap: 70))
        if let o = ov.first(where: { $0.provider == id && $0.hold != true }) {
            act("Togli lo sblocco di \(pName(id)) (attivo fino alle \(hhmmText(Int(o.until / 1000))))", "/api/override?provider=\(id)", "DELETE", [:])
        } else if st.state == "frenato" {
            act("Sblocca \(pName(id)) per 2 ore", "/api/override", "POST", ["provider": id, "hours": 2])
        }
    }
    sub.addItem(.separator())
    if let h = hold { act("Riprendi i lavori in background (fermi fino alle \(hhmmText(Int(h.until / 1000))))", "/api/hold", "DELETE", [:]) }
    else { act("Ferma i lavori nuovi in background per 1 ora", "/api/hold", "POST", ["hours": 1]) }
    sub.addItem(noteRow("Le sessioni aperte non si fermano mai: il freno vale per i lavori nuovi"))
    it.submenu = sub
    return it
}

// Hub che non risponde: ultimo dato buono e se è spento (niente in ascolto) o vivo ma lento (Mac sotto sforzo).
// 23/10, carico 138: l'hub era vivo, la tray al primo timeout diceva «spento» e la barra diventava «···».
struct HubLag { let lastOK: Date?; let refused: Bool }
var hubLag: HubLag?
func loadText() -> String {
    var l = [Double](repeating: 0, count: 3)
    let cores = ProcessInfo.processInfo.activeProcessorCount
    return getloadavg(&l, 1) == 1 ? "carico \(Int(l[0].rounded())) su \(cores) core" : "\(cores) core"
}
func hubLagRow(_ lag: HubLag, offline: Bool) -> NSMenuItem {
    let when = lag.lastOK.map { "numeri delle " + hhmmText(Int($0.timeIntervalSince1970)) } ?? "nessun numero"
    let title = lag.refused ? "Server dei consumi spento" : "Il server dei consumi non risponde"
    let detail = (lag.refused ? "niente in ascolto su :3360" : "acceso ma lento: il Mac è sotto sforzo (\(loadText()))")
        + (offline ? "" : " · qui sotto i \(when), riprovo ogni minuto")
    return richRow(icon: sym(lag.refused ? "bolt.horizontal.circle" : "hourglass", pt: 16, color: offline ? toneBad : toneWarn), txt(title, rowBold), detail: detail, wrap: 90)
}

// Un colpo d'occhio, non una dashboard: verdetto, account, chi lavora, il Mac se soffre.
// Il dettaglio (grafici, rinnovi, budget per progetto) sta in due sottomenu; il resto nella dashboard (:3360).
func buildMenu(snapshot: Overview?, isOffline: Bool, actionTarget: AnyObject?) -> NSMenu {
    let menu = NSMenu()
    menu.autoenablesItems = false
    if isOffline {
        menu.addItem(hubLagRow(hubLag ?? HubLag(lastOK: nil, refused: true), offline: true))
    } else {
        if let lag = hubLag { menu.addItem(hubLagRow(lag, offline: false)) }
        let providers = snapshot?.providers ?? []
        let renewals = snapshot?.renewals ?? []
        let cmap = creditMap(snapshot)
        var shown = Set<String>()
        var bonusShown = Set<String>()
        let details = NSMenu(); details.autoenablesItems = false
        var cards: [NSView] = [], afterGrid: [NSMenuItem] = []
        for p in providers {
            let accs = p.accounts ?? []
            let labels = Set(accs.map { $0.label })
            // Claude: solo i rinnovi degli account live vdm; gli altri finiscono tra gli orfani, senza perdersi.
            let pren = renewals.filter { $0.provider == p.id && (p.id != "claude" || labels.contains($0.account)) }
            if p.error == nil && p.billing != "usage" {
                // Tutto ciò che riguarda un account sta nel suo blocco: quote coi grafici, ritmo, freno, bonus, API, rinnovo.
                for a in accs {
                    let mine = pren.first { $0.account == a.label }
                    if let m = mine { shown.insert(m.service + "|" + m.account) }
                    let credit = p.id == "claude" ? cmap[a.label] : nil
                    if credit != nil { bonusShown.insert(a.label) }
                    if let b = accountBlock(p, a, renewal: mine, credit: credit, compactW: gridColW), let v = b.view { b.view = nil; cards.append(v) }
                }
                continue
            }
            // In errore: una riga in vista, sennò un abbonamento sparisce senza dirlo; il dettaglio resta nel sottomenu.
            if let err = p.error {
                // Account presente ma senza percentuale (il mint di Muse a volte la omette): si usa lo stesso, non è un guasto.
                let unread = !(p.accounts ?? []).isEmpty
                afterGrid.append(richRow(icon: providerSym(p.id, pt: 14, color: .secondaryLabelColor),
                                     txt(unread ? "\(p.name) · quota non letta" : "\(p.name) non raggiungibile", rowBold),
                                     detail: unread ? "il server non manda la percentuale adesso: il lavoro ci va lo stesso, al limite rifiuta \(p.name)" : "numeri e freno ignoti finché non risponde", tip: err))
            }
            // A consumo (ElevenLabs) o in errore: righe nel sottomenu, non in vista.
            let sub = NSMenu(); sub.autoenablesItems = false
            sub.addItem(sectionRow(p.name, providerId: p.id))
            if let err = p.error { sub.addItem(infoRow(err, x: MenuGrid.lead)) }
            else if accs.isEmpty { sub.addItem(infoRow("nessun account", x: MenuGrid.lead)) }
            for a in accs {
                sub.addItem(accountRow(a))
                for q in a.quotas { sub.addItem(hubQuotaRow(q)) }
            }
            addGroupedRenewals(pren, baseLabels: labels, menu: sub, shown: &shown)
            let d = providerRow(p); d.submenu = sub
            details.addItem(d)
        }
        let orphans = renewals.filter { $0.tray != false && !shown.contains($0.service + "|" + $0.account) }
        if !orphans.isEmpty {
            let sub = NSMenu(); sub.autoenablesItems = false
            addGroupedRenewals(orphans, baseLabels: [], menu: sub, shown: &shown)
            let it = richRow(icon: sym("calendar.badge.clock"), txt("Altri abbonamenti (\(orphans.count), fuori rotazione)", rowFont)); it.submenu = sub
            details.addItem(it)
        }
        let spare = cmap.filter { !bonusShown.contains($0.key) && $0.value.nobonus != true }
        if !spare.isEmpty, TrayPrefs.showBonus {
            let sub = NSMenu(); sub.autoenablesItems = false
            for email in spare.keys.sorted() {
                sub.addItem(emailRow(email))
                sub.addItem(creditRow(spare[email]!))
            }
            let it = richRow(icon: sym("creditcard"), txt("Credito AI", rowFont)); it.submenu = sub
            details.addItem(it)
        }
        // gli account affiancati in una griglia, una voce sola; le righe di chi non risponde subito sotto
        if !cards.isEmpty { let g = NSMenuItem(); g.view = GridView(cards); menu.addItem(g) }
        afterGrid.forEach { menu.addItem($0) }
        details.addItem(.separator())
        for (title, sel, on) in [
            ("Mostra fascia di 5 ore", #selector(AppDelegate.toggleDaily), TrayPrefs.showDaily),
            ("Mostra credito API", #selector(AppDelegate.toggleApi), TrayPrefs.showApi),
            ("Mostra bonus cloud", #selector(AppDelegate.toggleBonus), TrayPrefs.showBonus),
        ] {
            let it = NSMenuItem(title: title, action: sel, keyEquivalent: "")
            it.target = actionTarget
            it.state = on ? .on : .off
            details.addItem(it)
        }
        menu.addItem(.separator())
        liveAgentRows(actionTarget: actionTarget).forEach { menu.addItem($0) }
        if let ms = liveMachines, !ms.isEmpty {
            // ogni macchina è la stessa card; quella su cui gira la tray ha i processi nel sottomenu
            for m in ms { menu.addItem(.separator()); menu.addItem(machineItem(m)) }
            if ms.contains(where: { $0.local }) { menu.addItem(.separator()); macProcs.inlineSection().forEach { menu.addItem($0) } }
        } else {
            if let mr = macRow() {  // hub vecchio senza /api/machines: il Mac e il PC come prima
                menu.addItem(.separator()); menu.addItem(mr)
            }
            pcRow().forEach { menu.addItem($0) }
        }
        menu.addItem(.separator())
        let det = richRow(icon: sym("slider.horizontal.3"), txt("Altri abbonamenti e opzioni", rowFont)); det.submenu = details
        menu.addItem(det)
        menu.addItem(brakeMenuItem(actionTarget: actionTarget))
        if let pj = projectsMenuItem(actionTarget: actionTarget) { menu.addItem(pj) }
    }
    // con l'hub giù il blocco Mac non c'è: la finestra Processi legge tutto in locale e resta raggiungibile
    if isOffline || macRow() == nil {
        let pr = NSMenuItem(title: "Processi: cerca, ordina, chiudi…", action: #selector(AppDelegate.openProcesses), keyEquivalent: "p")
        pr.target = actionTarget; pr.image = sym("list.bullet.rectangle")
        menu.addItem(.separator()); menu.addItem(pr)
    }
    menu.addItem(automationsRow(actionTarget: actionTarget))
    menu.addItem(.separator())
    // Dashboard unica = la pagina del hub (:3360): freno, consumi, sessioni, impostazioni.
    for (title, sel, key, icon) in [
        ("Apri dashboard", #selector(AppDelegate.openDashboard), "d", "macwindow"),
        ("Aggiorna", #selector(AppDelegate.refresh), "r", "arrow.clockwise"),
        ("Esci", #selector(AppDelegate.quit), "q", "power"),
    ] {
        let it = NSMenuItem(title: title, action: sel, keyEquivalent: key)
        it.target = actionTarget
        it.image = sym(icon)
        menu.addItem(it)
    }
    return menu
}

// MARK: - Snapshot (--snapshot <file.png>: prova visiva senza barra)

// Disegna il menu in un PNG: le view delle voci una sotto l'altra su fondo
// finestra. Stesso menu del clic (buildMenu), niente status item, poi esce.
// SNAPSHOT_DEPTH=0 disegna solo il primo livello (quello che si vede al clic), default 1 come prima.
let snapshotDepth = Int(ProcessInfo.processInfo.environment["SNAPSHOT_DEPTH"] ?? "") ?? 1
func snapshotMenu(_ menu: NSMenu, path: String) -> Bool {
    struct Row { let image: NSImage; let height: CGFloat; var x: CGFloat = 0 }
    var rows: [Row] = []
    macProcs.prime()   // come all'apertura vera: la CPU dei processi è la media fino al passaggio sul Mac
    let titledFont = NSFont.systemFont(ofSize: 13)
    // Il menu è a livelli: sotto ogni voce con sottomenu si disegna il suo primo livello, rientrato.
    let indent: CGFloat = 28
    func flat(_ m: NSMenu, _ d: Int) -> [(NSMenuItem, Int)] {
        m.items.flatMap { it -> [(NSMenuItem, Int)] in
            if let sm = it.submenu, d < snapshotDepth { sm.delegate?.menuNeedsUpdate?(sm) }   // i sottomenu riempiti al passaggio (processi del Mac)
            return [(it, d)] + ((it.submenu != nil && d < snapshotDepth) ? flat(it.submenu!, d + 1) : [])
        }
    }
    let canvasW: CGFloat = 600
    for (item, depth) in flat(menu, 0) {
        let dx = CGFloat(depth) * indent
        if let view = item.view {
            if view.autoresizingMask.contains(.width) { view.setFrameSize(NSSize(width: canvasW, height: view.frame.height)) }
            let w = max(1, view.frame.width), h = max(1, view.frame.height)
            let bounds = NSRect(x: 0, y: 0, width: w, height: h)
            guard let rep = view.bitmapImageRepForCachingDisplay(in: bounds) else { continue }
            view.cacheDisplay(in: bounds, to: rep)
            let img = NSImage(size: bounds.size)
            img.addRepresentation(rep)
            rows.append(Row(image: img, height: h, x: dx))
        } else if item.isSeparatorItem {
            let h: CGFloat = 9
            let img = NSImage(size: NSSize(width: menuW, height: h))
            img.lockFocus()
            NSColor.separatorColor.setFill()
            NSRect(x: 1, y: h / 2, width: menuW - 2, height: 1).fill()
            img.unlockFocus()
            rows.append(Row(image: img, height: h))
        } else {
            // Stessa resa del menu vero: icona a sinistra, titolo attribuito (righe 1 e 2), freccia se ha un sottomenu.
            let title = item.attributedTitle ?? NSAttributedString(string: item.title, attributes: [.font: titledFont, .foregroundColor: NSColor.labelColor])
            let textW = canvasW - 60 - dx
            let th = ceil(title.boundingRect(with: NSSize(width: textW, height: 1000), options: [.usesLineFragmentOrigin]).height)
            let h = max(22, th + 8)
            let img = NSImage(size: NSSize(width: canvasW, height: h))
            img.lockFocus()
            if let ic = item.image { ic.draw(in: NSRect(x: 10 + dx, y: h - 4 - min(ic.size.height, 16) - 1, width: min(ic.size.width, 16), height: min(ic.size.height, 16))) }
            title.draw(with: NSRect(x: 32 + dx, y: 4, width: textW, height: th), options: [.usesLineFragmentOrigin])
            if item.submenu != nil { ("▸" as NSString).draw(at: NSPoint(x: canvasW - 20, y: h - 20), withAttributes: [.font: titledFont, .foregroundColor: NSColor.secondaryLabelColor]) }
            if !item.keyEquivalent.isEmpty { ("⌘" + item.keyEquivalent.uppercased() as NSString).draw(at: NSPoint(x: canvasW - 44, y: h - 20), withAttributes: [.font: titledFont, .foregroundColor: NSColor.tertiaryLabelColor]) }
            img.unlockFocus()
            rows.append(Row(image: img, height: h))
        }
    }
    let totalH = max(1, rows.reduce(0) { $0 + $1.height })
    let totalW = Int(canvasW)
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: totalW, pixelsHigh: Int(totalH),
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: totalW * 4, bitsPerPixel: 32)
    else { return false }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSColor.windowBackgroundColor.setFill()
    NSRect(x: 0, y: 0, width: canvasW, height: totalH).fill()
    var y = totalH
    for r in rows {
        y -= r.height
        r.image.draw(in: NSRect(x: r.x, y: y, width: r.image.size.width, height: r.height))
    }
    NSGraphicsContext.restoreGraphicsState()
    guard let png = rep.representation(using: .png, properties: [:]) else { return false }
    do {
        try png.write(to: URL(fileURLWithPath: path))
        return true
    } catch {
        return false
    }
}

func fetchOverviewSync() -> Overview? {
    guard let url = URL(string: hubURL + "/api/overview") else { return nil }
    var req = URLRequest(url: url)
    req.timeoutInterval = 55
    var out: Overview?
    let sem = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: req) { data, _, _ in
        defer { sem.signal() }
        guard let data = data else { return }
        out = try? JSONDecoder().decode(Overview.self, from: data)
    }.resume()
    _ = sem.wait(timeout: .now() + 60)
    return out
}

func runSnapshotAndExit(path: String) -> Never {
    _ = NSApplication.shared
    snapshotMode = true // font/colori come nella barra, senza runloop
    guard let snapshot = fetchOverviewSync() else {
        // Hub spento: il menu offline si disegna lo stesso («Automazioni · ?»), senza barra.
        let menu = buildMenu(snapshot: nil, isOffline: true, actionTarget: nil)
        if !snapshotMenu(menu, path: path) {
            FileHandle.standardError.write("usage-tray: --snapshot: scrittura \(path) fallita\n".data(using: .utf8)!)
            exit(1)
        }
        FileHandle.standardError.write("hub irraggiungibile: menu offline\n".data(using: .utf8)!)
        exit(0)
    }
    // Il main thread è bloccato qui: le risposte si leggono a mano, senza notify sul main.
    for (path, _) in livePaths {
        let ls = DispatchSemaphore(value: 0)
        guard let url = URL(string: hubURL + path) else { continue }
        URLSession.shared.dataTask(with: url) { data, _, _ in applyLive(path, data); ls.signal() }.resume()
        _ = ls.wait(timeout: .now() + 30)
    }
    // Accanto al menu anche la barra (<file>-bar.png, 2x su fondo scuro): si vede anche quando quella di macOS è nascosta.
    let bar = UsageBarView(frame: .zero); bar.snapshot = snapshot
    let bw = bar.idealWidth(); bar.frame = NSRect(x: 0, y: 0, width: bw, height: 22)
    if let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(bw * 2), pixelsHigh: 44, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) {
        rep.size = bar.frame.size
        NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSColor(white: 0.12, alpha: 1).setFill(); bar.bounds.fill(); bar.draw(bar.bounds)
        NSGraphicsContext.restoreGraphicsState()
        try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: (path as NSString).deletingPathExtension + "-bar.png"))
    }
    let menu = buildMenu(snapshot: snapshot, isOffline: false, actionTarget: nil)
    if !snapshotMenu(menu, path: path) {
        FileHandle.standardError.write("usage-tray: --snapshot: scrittura \(path) fallita\n".data(using: .utf8)!)
        exit(1)
    }
    exit(0)
}

// MARK: - App

class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    var statusItem: NSStatusItem!
    // Il menu si costruisce solo quando si apre: rifarlo due volte al minuto senza che nessuno lo guardasse
    // (viste, sottomenu dei progetti) era quasi tutta la CPU della tray.
    let menu = NSMenu()
    var menuStale = true
    var barView: UsageBarView!
    var timer: Timer?
    var snapshot: Overview?
    var isOffline = false
    var lastOK: Date?

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        barView = UsageBarView(frame: NSRect(x: 0, y: 0, width: 26, height: 22))
        statusItem.button?.addSubview(barView)
        statusItem.length = 26
        menu.autoenablesItems = false
        menu.delegate = self
        statusItem.menu = menu
        fetchData()
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            self?.fetchData()
        }
    }

    func fetchData() {
        guard let url = URL(string: hubURL + "/api/overview") else { return }
        var req = URLRequest(url: url)
        req.timeoutInterval = 55
        let task = URLSession.shared.dataTask(with: req) { [weak self] data, _, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let d = data, error == nil, let o = try? JSONDecoder().decode(Overview.self, from: d) {
                    self.snapshot = o; self.lastOK = Date(); self.isOffline = false; hubLag = nil
                } else {
                    // Gli ultimi numeri restano 10 minuti, con la loro ora nel menu: un hub lento non è un hub spento.
                    hubLag = HubLag(lastOK: self.lastOK, refused: (error as? URLError)?.code == .cannotConnectToHost)
                    self.isOffline = self.snapshot == nil || Date().timeIntervalSince(self.lastOK ?? .distantPast) > 600
                }
                self.updateUI()
                fetchLive { [weak self] in self?.rebuildMenu() }
            }
        }
        task.resume()
    }

    func updateUI() {
        barView.snapshot = snapshot
        barView.isOffline = isOffline
        let newWidth = barView.idealWidth()
        barView.frame = NSRect(x: 0, y: 0, width: newWidth, height: 22)
        statusItem.length = newWidth
        if isOffline {
            statusItem.button?.toolTip = hubLag?.refused == false ? "usage-hub :3360 non risponde (\(loadText()))" : "usage-hub offline (:3360)"
        } else {
            let parts = (snapshot?.providers ?? []).flatMap { $0.accounts ?? [] }
                .map { "\($0.label) (\($0.code)): \($0.quotas.map { "\($0.key.uppercased()) \($0.usedPct)% ↻\($0.resetText)\($0.detail.map { " " + $0 } ?? "")" }.joined(separator: " "))" + ($0.resetCredits.map { " (reset manuali: \($0.available))" } ?? "") }
            let lag = hubLag.map { l in "\(l.lastOK.map { "Numeri delle " + hhmmText(Int($0.timeIntervalSince1970)) } ?? "Numeri vecchi"): usage-hub :3360 non risponde\n" } ?? ""
            statusItem.button?.toolTip = lag + parts.joined(separator: "\n")
        }
        barView.needsDisplay = true
        rebuildMenu()
    }

    func menuWillOpen(_ menu: NSMenu) { macProcs.prime() }   // prima lettura dei processi: al passaggio sul Mac la CPU è la media da qui
    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menuStale else { return }
        let fresh = buildMenu(snapshot: snapshot, isOffline: isOffline, actionTarget: self)
        menu.removeAllItems()
        for item in fresh.items { fresh.removeItem(item); menu.addItem(item) }
        menuStale = false
    }

    func rebuildMenu() {
        menuStale = true
        barView.invalidate()
        let w = barView.idealWidth()
        if barView.frame.width != w { barView.frame = NSRect(x: 0, y: 0, width: w, height: 22); statusItem.length = w }
        barView.needsDisplay = true
    }

    @objc func refresh() { fetchData() }
    // Budget e priorità scritti nell'hub (budgets.json): li leggono gate, quota-guard e VDM.
    private func postProjectSetting(_ body: [String: Any]) {
        guard let url = URL(string: hubURL + "/api/project-settings"),
              let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        var req = URLRequest(url: url); req.httpMethod = "POST"; req.timeoutInterval = 10
        req.setValue("application/json", forHTTPHeaderField: "content-type"); req.httpBody = data
        URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in
            fetchLive { self?.rebuildMenu() }
        }.resume()
    }
    @objc func setProjectBudget(_ sender: NSMenuItem) {
        guard let o = sender.representedObject as? [String: Any], let name = o["name"] as? String, let b = o["budget"] as? Int else { return }
        postProjectSetting(["name": name, "budgetPct": b == 0 ? NSNull() : b])
    }
    @objc func setProjectPriority(_ sender: NSMenuItem) {
        guard let o = sender.representedObject as? [String: Any], let name = o["name"] as? String, let p = o["priority"] as? String else { return }
        postProjectSetting(["name": name, "priority": p])
    }
    @objc func brakeAction(_ sender: NSMenuItem) {
        guard let o = sender.representedObject as? [String: Any], let path = o["path"] as? String, let method = o["method"] as? String,
              let url = URL(string: hubURL + path) else { return }
        var req = URLRequest(url: url); req.httpMethod = method; req.timeoutInterval = 10
        if method == "POST", let b = o["body"] as? [String: Any] {
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            var body = b; body["by"] = "tray"
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in fetchLive { self?.rebuildMenu() } }.resume()
    }
    @objc func toggleDaily() { TrayPrefs.showDaily.toggle(); rebuildMenu() }
    @objc func toggleApi() { TrayPrefs.showApi.toggle(); rebuildMenu() }
    @objc func toggleBonus() { TrayPrefs.showBonus.toggle(); rebuildMenu() }

    @objc func openDashboard() {
        NSWorkspace.shared.open(URL(string: "http://localhost:3360/")!)
    }

    @objc func openAutomations() {
        let base = hubURL.replacingOccurrences(of: "127.0.0.1", with: "localhost")
        if let url = URL(string: base + "/#automations") { NSWorkspace.shared.open(url) }
    }

    @objc func openProcesses() { ProcessWindowController.shared.show() }

    // Clic su una sessione: la apre dove si trova (app Claude, tab Topics) e lascia una riga di log come prova.
    @objc func openLink(_ item: NSMenuItem) {
        guard let d = item.representedObject as? [String: String], let u = d["url"], let url = URL(string: u) else { return }
        let ok = NSWorkspace.shared.open(url)
        let line = "\(ISO8601DateFormatter().string(from: Date())) open \(ok ? "ok" : "FAIL") \(d["what"] ?? "") \(u)\n"
        let path = NSHomeDirectory() + "/.cache/claude-usage-hub/tray-open.log"
        if let h = FileHandle(forWritingAtPath: path) { h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); h.closeFile() } else { try? line.write(toFile: path, atomically: true, encoding: .utf8) }
    }

    @objc func quit() {
        NSApplication.shared.terminate(nil)
    }
}
