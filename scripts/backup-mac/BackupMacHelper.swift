// Eseguibile dentro «Backup Mac.app». Due mestieri:
//  run <script> [arg…]   lancia lo script e ne restituisce l'uscita. Serve perché macOS concede Documenti, Scrivania e
//                        iCloud Drive a un'app con un'identità propria, non a bash lanciato da launchd.
//  status|evict <dir>    legge lo stato iCloud dei file sotto <dir> o libera quelli già caricati. brctl evict non esiste
//                        più da macOS 14: resta solo l'API di FileManager.
import Foundation

func files(under dir: String) -> [URL] {
    let keys: [URLResourceKey] = [.isRegularFileKey]
    guard let en = FileManager.default.enumerator(at: URL(fileURLWithPath: dir), includingPropertiesForKeys: keys) else { return [] }
    return en.compactMap { $0 as? URL }.filter { (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true }
}

func values(_ u: URL) -> URLResourceValues? {
    try? u.resourceValues(forKeys: [.ubiquitousItemIsUploadedKey, .ubiquitousItemDownloadingStatusKey, .ubiquitousItemUploadingErrorKey, .fileSizeKey])
}

let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { fputs("uso: run|status|evict\n", stderr); exit(64) }

switch cmd {
case "run":
    let p = Process()
    p.executableURL = URL(fileURLWithPath: args[1])
    p.arguments = Array(args.dropFirst(2))
    try p.run()
    p.waitUntilExit()
    exit(p.terminationStatus)

case "status":
    var total = 0, totalB = 0, uploaded = 0, uploadedB = 0, local = 0, localB = 0
    var firstError = ""
    for u in files(under: args[1]) {
        guard let v = values(u) else { continue }
        let size = v.fileSize ?? 0
        total += 1; totalB += size
        if v.ubiquitousItemIsUploaded == true { uploaded += 1; uploadedB += size }
        if v.ubiquitousItemDownloadingStatus == .current { local += 1; localB += size }
        if firstError.isEmpty, let e = v.ubiquitousItemUploadingError { firstError = e.localizedDescription }
    }
    let out: [String: Any] = ["files": total, "bytes": totalB, "uploaded": uploaded, "uploaded_bytes": uploadedB,
                              "local": local, "local_bytes": localB, "error": firstError]
    let data = try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)

case "evict":
    var freed = 0, skipped = 0, failed = 0
    for u in files(under: args[1]) {
        guard let v = values(u), v.ubiquitousItemDownloadingStatus == .current else { continue }
        // mai liberare ciò che non è ancora su iCloud: sarebbe l'unica copia
        guard v.ubiquitousItemIsUploaded == true else { skipped += 1; continue }
        do { try FileManager.default.evictUbiquitousItem(at: u); freed += v.fileSize ?? 0 } catch { failed += 1 }
    }
    print("{\"freed_bytes\":\(freed),\"not_uploaded\":\(skipped),\"failed\":\(failed)}")

default:
    fputs("comando sconosciuto: \(cmd)\n", stderr); exit(64)
}
