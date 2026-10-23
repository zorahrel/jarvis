import Foundation
import Darwin

// Misure del Mac lette dal kernel, senza lanciare processi (vm_stat, top, ps costano un fork a ogni giro).
// Le formule della memoria sono quelle di Activity Monitor (e di Stats): «usata» = app + wired + compressa,
// la cache dei file (purgeable + external) è recuperabile e non conta come usata.
struct MemStats {
    let total: Double, app: Double, wired: Double, compressed: Double, cached: Double, free: Double   // byte
    let swapUsed: Double, swapTotal: Double
    let pressure: Int   // 1 normale, 2 attenzione, 4 critica (kern.memorystatus_vm_pressure_level)
    var used: Double { app + wired + compressed }
}

func readMem() -> MemStats? {
    var size = mach_msg_type_number_t(MemoryLayout<vm_statistics64_data_t>.stride / MemoryLayout<integer_t>.stride)
    var vm = vm_statistics64_data_t()
    let kr = withUnsafeMutablePointer(to: &vm) { p in
        p.withMemoryRebound(to: integer_t.self, capacity: Int(size)) { host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &size) }
    }
    guard kr == KERN_SUCCESS else { return nil }
    let page = Double(vm_kernel_page_size)
    let total = Double(ProcessInfo.processInfo.physicalMemory)
    let wired = Double(vm.wire_count) * page
    let compressed = Double(vm.compressor_page_count) * page
    let cached = Double(vm.purgeable_count + vm.external_page_count) * page
    let used = Double(vm.active_count + vm.inactive_count + vm.speculative_count + vm.wire_count + vm.compressor_page_count) * page - cached
    let app = max(used - wired - compressed, 0)
    var sw = xsw_usage(); var swSize = MemoryLayout<xsw_usage>.size
    sysctlbyname("vm.swapusage", &sw, &swSize, nil, 0)
    var lvl: Int32 = 1; var lvlSize = MemoryLayout<Int32>.size
    sysctlbyname("kern.memorystatus_vm_pressure_level", &lvl, &lvlSize, nil, 0)
    return MemStats(total: total, app: app, wired: wired, compressed: compressed, cached: cached, free: max(total - used - cached, 0),   // né usata né cache: le voci sommano al totale
                    swapUsed: Double(sw.xsu_used), swapTotal: Double(sw.xsu_total), pressure: Int(lvl))
}

func bytesText(_ b: Double) -> String {
    let gb = b / 1_073_741_824
    return (gb >= 100 ? String(format: "%.0f GB", gb) : gb >= 1 ? String(format: "%.1f GB", gb) : String(format: "%.0f MB", b / 1_048_576)).replacingOccurrences(of: ".", with: ",")
}
func pressureText(_ p: Int) -> String { p >= 4 ? "critica" : p >= 2 ? "in attenzione" : "normale" }
