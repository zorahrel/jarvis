import AppKit
import Darwin

// Finestra dei processi: cerca, ordina, raggruppa per app, chiudi. Letti dal kernel con libproc (proc_pid_rusage),
// niente `top` o `ps` lanciati a ogni giro, e solo mentre la finestra è aperta: chiusa non costa niente.
// Memoria = impronta fisica (ri_phys_footprint), la stessa colonna «Memoria» di Activity Monitor, non l'RSS che su
// Node e Bun gonfia di decine di volte. CPU = % di un core, come Activity Monitor (200% = due core pieni).

struct ProcRow {
    let pid: pid_t; let name: String; let detail: String; let cpu: Double; let mem: Double; let threads: Int
    let respPid: pid_t; var count: Int = 1; var pids: [pid_t] = []
    var start: UInt64 = 0          // ora di nascita: prima di chiudere si ricontrolla, un pid riusato non è lo stesso processo
    var system = false             // eseguibile di macOS (/System, /usr/libexec, /usr/sbin, /sbin): si vede, non si chiude da qui
}

final class ProcSampler {
    private var last: [pid_t: (cpuNs: UInt64, at: UInt64)] = [:]
    private var names: [pid_t: (String, String)] = [:]
    private let tb: (UInt64, UInt64) = { var t = mach_timebase_info(); mach_timebase_info(&t); return (UInt64(t.numer), UInt64(t.denom)) }()
    private typealias RespFn = @convention(c) (pid_t) -> pid_t
    private let resp: RespFn? = {
        guard let s = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid") else { return nil }
        return unsafeBitCast(s, to: RespFn.self)
    }()

    func reset() { last = [:] }   // riaperta la finestra, la prima CPU non è la media di tutto il tempo a finestra chiusa
    // Il pid è ancora quel processo? Stesso istante di nascita = sì; uscito o riusato = no.
    func startTime(_ pid: pid_t) -> UInt64? {
        var bi = proc_bsdinfo()
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bi, Int32(MemoryLayout<proc_bsdinfo>.size)) > 0 else { return nil }
        return bi.pbi_start_tvsec * 1_000_000 + bi.pbi_start_tvusec
    }
    private var paths: [pid_t: (start: UInt64, system: Bool)] = [:]
    func sample() -> [ProcRow] {
        let n = proc_listallpids(nil, 0)
        guard n > 0 else { return [] }
        var pids = [pid_t](repeating: 0, count: Int(n) + 64)
        let got = Int(proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size)))
        let now = mach_absolute_time()
        var rows: [ProcRow] = [], seen = Set<pid_t>()
        for pid in pids.prefix(got) where pid > 0 {
            var ri = rusage_info_v4()
            let ok = withUnsafeMutablePointer(to: &ri) { p in
                p.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
            }
            guard ok == 0 else { continue }   // processi di altri utenti: non leggibili, e comunque non chiudibili da qui
            var bi = proc_bsdinfo()
            guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bi, Int32(MemoryLayout<proc_bsdinfo>.size)) > 0, bi.pbi_status != UInt32(SZOMB) else { continue }  // zombie: già usciti
            let start = bi.pbi_start_tvsec * 1_000_000 + bi.pbi_start_tvusec
            // pid riusato da un altro processo: via nome, percorso e base della CPU del vecchio
            if let p = paths[pid], p.start != start { names[pid] = nil; last[pid] = nil; paths[pid] = nil }
            if paths[pid] == nil {
                var pb = [CChar](repeating: 0, count: 4096)
                let path = proc_pidpath(pid, &pb, UInt32(pb.count)) > 0 ? String(cString: pb) : ""
                paths[pid] = (start, ["/System/", "/usr/libexec/", "/usr/sbin/", "/sbin/", "/Library/Apple/"].contains { path.hasPrefix($0) })
            }
            seen.insert(pid)
            let cpuNs = (ri.ri_user_time + ri.ri_system_time) * tb.0 / tb.1
            var cpu = 0.0
            if let l = last[pid], now > l.at, cpuNs >= l.cpuNs {
                cpu = Double(cpuNs - l.cpuNs) / Double((now - l.at) * tb.0 / tb.1) * 100
            }
            last[pid] = (cpuNs, now)
            let (name, detail) = names[pid] ?? label(pid)
            names[pid] = (name, detail)
            var ti = proc_taskinfo()
            let th = proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &ti, Int32(MemoryLayout<proc_taskinfo>.size)) > 0 ? Int(ti.pti_threadnum) : 0
            let rp = resp?(pid) ?? pid
            rows.append(ProcRow(pid: pid, name: name, detail: detail, cpu: cpu, mem: Double(ri.ri_phys_footprint), threads: th, respPid: rp > 0 ? rp : pid, pids: [pid], start: start, system: paths[pid]?.system ?? false))
        }
        last = last.filter { seen.contains($0.key) }
        names = names.filter { seen.contains($0.key) }
        paths = paths.filter { seen.contains($0.key) }
        return rows
    }

    // Nome leggibile: l'app se c'è, altrimenti il nome del processo; per gli interpreti (node, python, bun…) lo script,
    // perché venti «node» uguali non dicono chi è chi.
    private func label(_ pid: pid_t) -> (String, String) {
        if let app = NSRunningApplication(processIdentifier: pid), let n = app.localizedName { return (n, app.bundleIdentifier ?? "") }
        var buf = [CChar](repeating: 0, count: 256)
        proc_name(pid, &buf, UInt32(buf.count))
        let name = String(cString: buf)
        let args = argv(pid)
        // un eseguibile installato in una cartella di versione (claude → versions/2.1.301) si chiama come argv[0]
        let shown = name.range(of: #"^\d+(\.\d+)+$"#, options: .regularExpression) != nil ? ((args.first ?? name) as NSString).lastPathComponent : name
        let interp = ["node", "python", "python3", "bun", "deno", "ruby", "java", "Python"]
        if interp.contains(name) || name.hasPrefix("python"), let script = args.dropFirst().first(where: { !$0.hasPrefix("-") }) {
            // «index.js» da solo non dice di chi è: si aggiunge la cartella (openclaw/index.js)
            let comps = (script as NSString).pathComponents.filter { $0 != "/" && $0 != "dist" && $0 != "bin" && $0 != "src" && $0 != "build" }
            let generic = ["index.js", "main.js", "cli.js", "server.js", "index.mjs", "main.py", "__main__.py", "cli.mjs", "run.js"]
            let tail = generic.contains(comps.last ?? "") && comps.count >= 2 ? comps.suffix(2).joined(separator: "/") : (comps.last ?? script)
            return ("\(name) \(tail)", args.dropFirst().joined(separator: " "))
        }
        // tre «claude» uguali non dicono quale lavora dove: gli agenti portano la cartella (claude · topics-app)
        if ["claude", "codex", "muse"].contains(shown), let dir = cwd(pid), dir != NSHomeDirectory() {
            return ("\(shown) · \((dir as NSString).lastPathComponent)", args.joined(separator: " ") + "  (in \(dir))")
        }
        return (shown.isEmpty ? "pid \(pid)" : shown, args.joined(separator: " "))
    }
    private func cwd(_ pid: pid_t) -> String? {
        var info = proc_vnodepathinfo()
        let n = proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &info, Int32(MemoryLayout<proc_vnodepathinfo>.size))
        guard n == MemoryLayout<proc_vnodepathinfo>.size else { return nil }
        let path = withUnsafeBytes(of: info.pvi_cdir.vip_path) { String(cString: $0.bindMemory(to: CChar.self).baseAddress!) }
        return path.isEmpty ? nil : path
    }
    private func argv(_ pid: pid_t) -> [String] {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 0 else { return [] }
        var buf = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &buf, &size, nil, 0) == 0, size > 4 else { return [] }
        let argc = Int(buf.withUnsafeBytes { $0.load(as: Int32.self) })
        var i = 4
        while i < size && buf[i] != 0 { i += 1 }        // percorso dell'eseguibile
        while i < size && buf[i] == 0 { i += 1 }        // riempitivo
        var out: [String] = []
        while out.count < argc && i < size {
            var j = i; while j < size && buf[j] != 0 { j += 1 }
            out.append(String(decoding: buf[i..<j], as: UTF8.self)); i = j + 1
        }
        return out
    }
}

// Chiusura condivisa fra finestra e menu della tray: mai i processi di macOS né la tray stessa; le app ricevono
// terminate() come dal Dock (chiedono di salvare), gli altri SIGTERM; forzare = forceTerminate/SIGKILL.
// Prima di colpire si ricontrolla l'ora di nascita: un pid uscito o riusato nel frattempo non si tocca.
func killSplit(_ targets: [ProcRow]) -> (ok: [ProcRow], blocked: [ProcRow]) {
    let me = ProcessInfo.processInfo.processIdentifier
    return (targets.filter { !($0.system || $0.pid == me) }, targets.filter { $0.system || $0.pid == me })
}
func killAlert(ok: [ProcRow], blocked: [ProcRow], force: Bool) -> NSAlert {
    let names = Dictionary(grouping: ok, by: { $0.name }).map { $0.value.count > 1 ? "\($0.key) ×\($0.value.count)" : $0.key }.sorted()
    let a = NSAlert()
    a.messageText = "\(force ? "Forzare la chiusura di" : "Chiudere") \(names.count == 1 ? names[0] : "\(ok.count) processi")?"
    a.informativeText = (names.count > 1 ? names.prefix(12).joined(separator: ", ") + (names.count > 12 ? "…" : "") + "\n\n" : "")
        + (force ? "Forzare non lascia salvare niente." : "Le app chiedono di salvare come quando le chiudi dal Dock; gli altri processi ricevono SIGTERM.")
        + (blocked.isEmpty ? "" : "\nSaltati: \(blocked.map { $0.name }.joined(separator: ", ")) (macOS o la tray).")
    a.addButton(withTitle: force ? "Forza chiusura" : "Chiudi"); a.addButton(withTitle: "Annulla")
    return a
}
func killRows(_ ok: [ProcRow], force: Bool, startTime: (pid_t) -> UInt64?) -> [String] {
    var failed: [String] = []
    for r in ok {
        guard startTime(r.pid) == r.start else { continue }
        if let app = NSRunningApplication(processIdentifier: r.pid) {
            if !(force ? app.forceTerminate() : app.terminate()) { failed.append(r.name) }
        } else if kill(r.pid, force ? SIGKILL : SIGTERM) != 0 { failed.append(r.name) }
    }
    return failed
}

// Per app: i processi di cui un'app è responsabile (helper, renderer) sommati sotto il suo nome, come Activity Monitor.
func groupByApp(_ rows: [ProcRow], all: [ProcRow]) -> [ProcRow] {
    var by: [pid_t: ProcRow] = [:]
    for r in rows {
        if let g = by[r.respPid] {
            by[r.respPid] = ProcRow(pid: g.pid, name: g.name, detail: g.detail, cpu: g.cpu + r.cpu, mem: g.mem + r.mem, threads: g.threads + r.threads, respPid: g.respPid, count: g.count + 1, pids: g.pids + [r.pid], start: g.start, system: g.system)   // di macOS se lo è l'app, non se lo è un suo helper
        } else {
            let head = all.first { $0.pid == r.respPid } ?? r
            by[r.respPid] = ProcRow(pid: r.respPid, name: head.name, detail: head.detail, cpu: r.cpu, mem: r.mem, threads: r.threads, respPid: r.respPid, count: 1, pids: [r.pid], start: head.start, system: head.system)
        }
    }
    return Array(by.values)
}

final class ProcessWindowController: NSObject, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate, NSWindowDelegate {
    static let shared = ProcessWindowController()
    private var window: NSWindow?
    private let table = NSTableView()
    private let search = NSSearchField()
    private let group = NSButton(checkboxWithTitle: "Raggruppa per app", target: nil, action: nil)
    private let footer = NSTextField(labelWithString: "")
    private let sampler = ProcSampler()
    private var all: [ProcRow] = [], shown: [ProcRow] = []
    private var timer: Timer?
    private var sortKey = "cpu", ascending = false
    private var notice: (text: String, until: Date)?   // esito di una chiusura: resta 8 s, non lo cancella il giro dopo

    func show(query: String? = nil) {
        if window == nil { build() }
        if let q = query { search.stringValue = q }
        refresh()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refresh() }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        window?.makeFirstResponder(search)
    }
    func windowWillClose(_ n: Notification) { timer?.invalidate(); timer = nil; sampler.reset() }
    func snapshot(path: String, query: String) -> Bool {
        _ = NSApplication.shared
        build(); search.stringValue = query
        _ = sampler.sample(); Thread.sleep(forTimeInterval: 1); refresh()
        guard let v = window?.contentView else { return false }
        v.appearance = NSAppearance(named: .darkAqua); window?.layoutIfNeeded(); v.layoutSubtreeIfNeeded(); table.sizeLastColumnToFit(); table.layoutSubtreeIfNeeded()
        guard let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return false }
        v.cacheDisplay(in: v.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { return false }
        return (try? png.write(to: URL(fileURLWithPath: path))) != nil
    }

    private func build() {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 560), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        w.title = "Processi"; w.isReleasedWhenClosed = false; w.delegate = self; w.minSize = NSSize(width: 560, height: 300)
        w.center()
        let v = NSView()
        search.placeholderString = "Cerca per nome, script o PID"
        search.delegate = self
        group.target = self; group.action = #selector(regroup)
        let kill = NSButton(title: "Chiudi", target: self, action: #selector(terminate))
        let force = NSButton(title: "Forza chiusura", target: self, action: #selector(forceQuit))
        kill.bezelStyle = .rounded; force.bezelStyle = .rounded
        footer.textColor = .secondaryLabelColor; footer.font = .systemFont(ofSize: 11)
        let cols: [(String, String, CGFloat, Bool)] = [("name", "Processo", 300, true), ("cpu", "CPU %", 70, false), ("mem", "Memoria", 90, false), ("threads", "Thread", 60, false), ("pid", "PID", 70, false)]
        for (id, title, width, asc) in cols {
            let c = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(id))
            c.title = title; c.width = width; c.minWidth = 50
            c.sortDescriptorPrototype = NSSortDescriptor(key: id, ascending: asc)
            if id != "name" { c.headerCell.alignment = .right }
            table.addTableColumn(c)
        }
        table.dataSource = self; table.delegate = self
        table.usesAlternatingRowBackgroundColors = true
        table.columnAutoresizingStyle = .firstColumnOnlyAutoresizingStyle   // lo spazio in più va al nome, non al PID
        table.allowsMultipleSelection = true
        table.rowHeight = 22
        table.sortDescriptors = [NSSortDescriptor(key: "cpu", ascending: false)]
        table.doubleAction = #selector(doubleClicked); table.target = self
        let scroll = NSScrollView(); scroll.documentView = table; scroll.hasVerticalScroller = true; scroll.borderType = .noBorder
        for x in [search, group, kill, force, footer, scroll] as [NSView] { x.translatesAutoresizingMaskIntoConstraints = false; v.addSubview(x) }
        NSLayoutConstraint.activate([
            search.topAnchor.constraint(equalTo: v.topAnchor, constant: 10), search.leadingAnchor.constraint(equalTo: v.leadingAnchor, constant: 12),
            search.widthAnchor.constraint(equalToConstant: 260),
            group.centerYAnchor.constraint(equalTo: search.centerYAnchor), group.leadingAnchor.constraint(equalTo: search.trailingAnchor, constant: 14),
            force.centerYAnchor.constraint(equalTo: search.centerYAnchor), force.trailingAnchor.constraint(equalTo: v.trailingAnchor, constant: -12),
            kill.centerYAnchor.constraint(equalTo: search.centerYAnchor), kill.trailingAnchor.constraint(equalTo: force.leadingAnchor, constant: -6),
            scroll.topAnchor.constraint(equalTo: search.bottomAnchor, constant: 10), scroll.leadingAnchor.constraint(equalTo: v.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: v.trailingAnchor), scroll.bottomAnchor.constraint(equalTo: footer.topAnchor, constant: -6),
            footer.leadingAnchor.constraint(equalTo: v.leadingAnchor, constant: 12), footer.trailingAnchor.constraint(equalTo: v.trailingAnchor, constant: -12),
            footer.bottomAnchor.constraint(equalTo: v.bottomAnchor, constant: -8),
        ])
        w.contentView = v
        window = w
    }

    private func refresh() {
        all = sampler.sample()
        apply()
        let cpu = all.reduce(0) { $0 + $1.cpu }, mem = all.reduce(0) { $0 + $1.mem }
        let cores = ProcessInfo.processInfo.activeProcessorCount
        footer.stringValue = "\(all.count) processi tuoi · CPU \(Int(cpu))% su \(cores * 100)% (\(cores) core) · memoria \(bytesText(mem))"
            + (readMem().map { " · RAM libera \(bytesText($0.free)), swap \(bytesText($0.swapUsed)), pressione \(pressureText($0.pressure))" } ?? "")
            + " · aggiornata ogni 2 s · quelli di macOS (in grigio) e degli altri utenti non si chiudono da qui"
        if let n = notice, n.until > Date() { footer.stringValue = n.text + " — " + footer.stringValue }
    }
    private func apply() {
        let sel = Set(table.selectedRowIndexes.compactMap { $0 < shown.count ? shown[$0].pid : nil })
        // si cerca sui singoli processi, prima di raggruppare: un processo dentro un gruppo si trova lo stesso
        let q = search.stringValue.trimmingCharacters(in: .whitespaces).lowercased()
        var rows = q.isEmpty ? all : all.filter { $0.name.lowercased().contains(q) || $0.detail.lowercased().contains(q) || String($0.pid) == q }
        if group.state == .on { rows = groupByApp(rows, all: all) }
        // ordinamento stretto con spareggio sul pid: senza, a pari valore le righe si rimescolavano a ogni giro
        rows.sort { a, b in
            let c: ComparisonResult
            switch sortKey {
            case "name": c = a.name.localizedCaseInsensitiveCompare(b.name)
            case "mem": c = a.mem == b.mem ? .orderedSame : a.mem < b.mem ? .orderedAscending : .orderedDescending
            case "threads": c = a.threads == b.threads ? .orderedSame : a.threads < b.threads ? .orderedAscending : .orderedDescending
            case "pid": c = .orderedSame
            default: c = a.cpu == b.cpu ? .orderedSame : a.cpu < b.cpu ? .orderedAscending : .orderedDescending
            }
            if c == .orderedSame { return ascending || sortKey != "pid" ? a.pid < b.pid : a.pid > b.pid }
            return ascending ? c == .orderedAscending : c == .orderedDescending
        }
        shown = rows
        table.reloadData()
        table.selectRowIndexes(IndexSet(shown.indices.filter { sel.contains(shown[$0].pid) }), byExtendingSelection: false)
    }

    @objc private func regroup() { apply() }
    func controlTextDidChange(_ obj: Notification) { apply() }
    func tableView(_ t: NSTableView, sortDescriptorsDidChange old: [NSSortDescriptor]) {
        guard let d = t.sortDescriptors.first, let k = d.key else { return }
        sortKey = k; ascending = d.ascending; apply()
    }
    func numberOfRows(in t: NSTableView) -> Int { shown.count }
    func tableView(_ t: NSTableView, viewFor col: NSTableColumn?, row: Int) -> NSView? {
        guard let id = col?.identifier.rawValue, row < shown.count else { return nil }
        let r = shown[row]
        let f = NSTextField(labelWithString: "")
        f.lineBreakMode = .byTruncatingTail
        switch id {
        case "name":
            f.stringValue = r.count > 1 ? "\(r.name)  (\(r.count))" : r.name
            f.toolTip = (r.system ? "Processo di macOS: non si chiude da qui. " : "") + r.detail
            if r.system { f.textColor = .secondaryLabelColor }
        case "cpu": f.stringValue = String(format: "%.1f", r.cpu).replacingOccurrences(of: ".", with: ","); f.alignment = .right
            f.textColor = r.cpu >= 80 ? .systemRed : r.cpu >= 30 ? .systemOrange : .labelColor
            f.font = .monospacedDigitSystemFont(ofSize: 12, weight: r.cpu >= 30 ? .semibold : .regular)
        case "mem": f.stringValue = bytesText(r.mem); f.alignment = .right
            f.textColor = r.mem >= 2 * 1_073_741_824 ? .systemOrange : .labelColor
            f.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        case "threads": f.stringValue = "\(r.threads)"; f.alignment = .right; f.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        default: f.stringValue = "\(r.pid)"; f.alignment = .right; f.textColor = .secondaryLabelColor; f.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        }
        return f
    }

    @objc private func doubleClicked() { if table.clickedRow >= 0 { terminate() } }   // non sull'intestazione delle colonne
    @objc private func terminate() { send(force: false) }
    @objc private func forceQuit() { send(force: true) }
    // Sempre con conferma, e con i nomi: un processo chiuso non torna. Le app si chiudono come dal Dock (terminate: chiedono
    // di salvare, possono rifiutare); il SIGTERM nudo le uccideva senza dialogo. Forza = forceTerminate / SIGKILL.
    // Mai: processi di macOS, la tray stessa. Prima del segnale si ricontrolla l'istante di nascita: un pid riusato si salta.
    private func send(force: Bool) {
        let rows = table.selectedRowIndexes.compactMap { $0 < shown.count ? shown[$0] : nil }
        guard !rows.isEmpty, let w = window else { return }
        let (ok, blocked) = killSplit(all.filter { r in rows.contains { $0.pids.contains(r.pid) } })
        guard !ok.isEmpty else { flash("Non si chiude da qui: \(blocked.map { $0.name }.joined(separator: ", ")) (processo di macOS o la tray stessa)"); return }
        killAlert(ok: ok, blocked: blocked, force: force).beginSheetModal(for: w) { [weak self] resp in
            guard resp == .alertFirstButtonReturn, let self else { return }
            let failed = killRows(ok, force: force, startTime: self.sampler.startTime)
            if !failed.isEmpty { self.flash("Non chiusi (permesso negato): \(failed.joined(separator: ", "))") }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { self.refresh() }
        }
    }
    private func flash(_ t: String) { notice = (t, Date().addingTimeInterval(8)); footer.stringValue = t }
}
