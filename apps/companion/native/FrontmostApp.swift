// lifeos-frontmost: reports which app is in front, and nothing else.
//
// Prints one JSON line {"bundleId": ..., "name": ...} when the frontmost app
// changes, plus a heartbeat every 30 s. It reads only
// NSWorkspace.frontmostApplication, which needs no Accessibility or Screen
// Recording permission and exposes no window titles or content.
//
// The helper exits when its parent (the companion) goes away.

import AppKit
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

let parentPid = getppid()
var lastLine = ""

func emit(_ app: NSRunningApplication?, force: Bool = false) {
    let payload: [String: Any] = [
        "bundleId": app?.bundleIdentifier ?? NSNull(),
        "name": app?.localizedName ?? NSNull(),
    ]
    guard
        let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
        let line = String(data: data, encoding: .utf8)
    else { return }
    if line == lastLine && !force { return }
    lastLine = line
    print(line)
}

let workspace = NSWorkspace.shared
emit(workspace.frontmostApplication, force: true)

workspace.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification,
    object: nil,
    queue: .main
) { note in
    emit(note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
}

Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in
    // Re-parented to launchd means the companion is gone.
    if getppid() != parentPid { exit(0) }
    emit(workspace.frontmostApplication, force: true)
}

RunLoop.main.run()
