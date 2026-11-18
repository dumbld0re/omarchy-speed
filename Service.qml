import QtQuick
import Quickshell
import Quickshell.Io

// One per desktop session. Owns the only test runner, the history and the
// auto-test schedule; every bar widget instance (one per monitor) just shows
// this state, so tests never run in parallel.
Item {
  id: root

  // Injected by omarchy-shell.
  property var shell: null

  // bin/speed runs only the CLI bundled in cli/ (dist/speed if built, else the source with Bun).
  readonly property string bin: Qt.resolvedUrl("bin/speed").toString().replace("file://", "")

  property var results: []                 // oldest → newest
  readonly property var last: results.length ? results[results.length - 1] : null
  property bool running: false
  property string phase: ""                // connect | latency | download | upload | done
  property var live: ({})
  property string error: ""
  property real now: Date.now()

  // Set by the widgets from their "autoTestMinutes" setting (0 = off). All
  // instances share one bar entry, so they agree; the schedule lives here.
  property int autoTestMinutes: 0

  function reload() {
    if (!historyProc.running) historyProc.running = true
  }

  function runTest() {
    if (running) return
    error = ""
    live = ({})
    phase = "connect"
    running = true
    testProc.running = true
  }

  // Skip a scheduled test if a recent result already exists (e.g. after a
  // shell restart, or a test run from the terminal).
  function autoTest() {
    var intervalMs = autoTestMinutes * 60000
    if (last && Date.now() - Date.parse(last.timestamp) < intervalMs * 0.9) return
    runTest()
  }

  Process {
    id: historyProc
    command: [root.bin, "history", "--json", "--limit", "24"]
    stdout: StdioCollector {
      onStreamFinished: {
        try { root.results = JSON.parse(text) } catch (e) {}
      }
    }
    onExited: function(code) {
      if (code === 127) root.error = "Needs Bun, see README"
    }
  }

  Process {
    id: testProc
    command: [root.bin, "--stream"]
    stdout: SplitParser {
      onRead: function(line) {
        var ev
        try { ev = JSON.parse(line) } catch (e) { return }
        if (ev.event === "progress") {
          root.phase = ev.phase
          root.live = ev
        } else if (ev.event === "result") {
          root.phase = "done"
          root.live = ev
        } else if (ev.event === "error") {
          root.error = ev.message
        }
      }
    }
    onExited: function(code) {
      root.running = false
      if (code !== 0 && root.error === "") root.error = "Test failed"
      root.reload()
    }
  }

  Timer {
    // Cheap: re-read history (picks up `speed watch` / terminal runs) and refresh "x min ago".
    interval: 60000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: { root.now = Date.now(); root.reload() }
  }

  Timer {
    interval: Math.max(1, root.autoTestMinutes) * 60000
    running: root.autoTestMinutes > 0
    repeat: true
    onTriggered: root.autoTest()
  }
}
