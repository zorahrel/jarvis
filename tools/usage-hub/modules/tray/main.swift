import Cocoa

// Punto di ingresso: deve stare in main.swift perché l'app ora è multi-file
// (ClaudeUsage.swift, ProviderIcon.swift, MacStats.swift, ProcessWindow.swift).

// Prova visiva: stesso menu del clic in un PNG, senza toccare la barra.
// Prima del lock single-instance: lo snapshot gira accanto alla tray vera.
if let i = CommandLine.arguments.firstIndex(of: "--snapshot") {
    guard i + 1 < CommandLine.arguments.count else {
        FileHandle.standardError.write("uso: ClaudeUsage --snapshot <file.png>\n".data(using: .utf8)!)
        exit(2)
    }
    runSnapshotAndExit(path: CommandLine.arguments[i + 1])
}
// Prova visiva della finestra Processi: due letture a 1 s (la CPU è una differenza), poi il PNG. «--processes <png> [cerca]»
if let i = CommandLine.arguments.firstIndex(of: "--processes"), i + 1 < CommandLine.arguments.count {
    let q = i + 2 < CommandLine.arguments.count ? CommandLine.arguments[i + 2] : ""
    exit(ProcessWindowController.shared.snapshot(path: CommandLine.arguments[i + 1], query: q) ? 0 : 1)
}

// Single instance guard via an advisory lock on the pidfile.
//
// A bare `kill(pid, 0)` is not a liveness test: macOS recycles PIDs, so a stale
// file from a crashed tray eventually names an unrelated live process and the
// guard exits(0) forever. Seen for real on 2026-08-30 — the file held 1120,
// which by then belonged to `jcode serve`, so KeepAlive respawned the tray
// 3360 times and it vanished from the menubar with no error anywhere.
//
// flock() cannot lie: the kernel drops the lock when the holder dies, whatever
// happens to the PID. The file still carries the pid, for humans reading it.
// It lives in Application Support (created here): anywhere else assumes
// folders a fresh Mac doesn't have, and open() would fail the tray forever.
let supportDir = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/claude-usage-tray", isDirectory: true)
try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
let pidFile = supportDir.appendingPathComponent("usage-tray.pid").path
let lockFD = open(pidFile, O_CREAT | O_RDWR, 0o644)
if lockFD < 0 {
    FileHandle.standardError.write("usage-tray: cannot open \(pidFile): \(String(cString: strerror(errno)))\n".data(using: .utf8)!)
    exit(1)
}
if flock(lockFD, LOCK_EX | LOCK_NB) != 0 {
    // Another tray holds the lock: this one is the duplicate.
    exit(0)
}
ftruncate(lockFD, 0)
let pidBytes = Array("\(ProcessInfo.processInfo.processIdentifier)\n".utf8)
_ = pidBytes.withUnsafeBufferPointer { write(lockFD, $0.baseAddress, $0.count) }
// lockFD is deliberately never closed: the lock must outlive this scope.

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
