import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// Speed — the `speed` CLI (fast.com) in the bar.
// Bar shows the last download speed; while a test runs it shows the live reading.
// History comes from `speed history --json`; tests run `speed --stream` (JSON lines).
Panel {
  id: root
  moduleName: "danny-miguel.speed"
  ipcTarget: "danny-miguel.speed"
  manageIpc: false

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // bin/speed uses ~/.local/bin/speed when present, else runs cli/ with Bun.
  readonly property string bin: Qt.resolvedUrl("bin/speed").toString().replace("file://", "")
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color accent: Color.accent
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property color faint: Qt.darker(foreground, 2.6)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  property var results: []                 // oldest → newest
  readonly property var last: results.length ? results[results.length - 1] : null
  property bool running: false
  property string phase: ""                // connect | latency | download | upload | done
  property var live: ({})
  property string error: ""
  property real now: Date.now()
  readonly property var downs: results.map(function(r) { return r.downloadMbps })
  readonly property real bestDown: Math.max.apply(null, downs.concat([0.001]))
  readonly property real avgDown: downs.reduce(function(a, b) { return a + b }, 0) / Math.max(1, downs.length)

  // ── formatting (matches the CLI) ──
  function num(mbps) {
    if (mbps === null || mbps === undefined) return "–"
    if (mbps >= 1000) return (mbps / 1000).toFixed(2)
    if (mbps >= 100) return mbps.toFixed(0)
    if (mbps >= 1) return mbps.toFixed(1)
    return mbps.toFixed(2)
  }
  function unit(mbps) { return mbps !== null && mbps >= 1000 ? "Gbps" : "Mbps" }
  function ago(iso) {
    var m = Math.round((now - Date.parse(iso)) / 60000)
    if (m < 1) return "just now"
    if (m < 60) return m + " min ago"
    if (m < 1440) return Math.round(m / 60) + " h ago"
    return Math.round(m / 1440) + " d ago"
  }
  function phaseLabel() {
    switch (phase) {
    case "connect": return "Finding servers…"
    case "latency": return "Measuring latency…"
    case "download": return "Testing download…"
    case "upload": return "Testing upload…"
    case "done": return "Saving…"
    default: return "Starting…"
    }
  }

  readonly property string barText: {
    if (running) {
      if (phase === "upload") return "󰓅 ↑ " + num(live.uploadMbps)
      if (phase === "download") return "󰓅 ↓ " + num(live.downloadMbps)
      return "󰓅 …"
    }
    if (!last) return "󰓅"
    var t = "󰓅 " + num(last.downloadMbps)
    if (setting("showUpload", false) && last.uploadMbps !== null) t += " ↑ " + num(last.uploadMbps)
    return t
  }

  // ── processes ──
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

  function openTerminal(args) {
    Quickshell.execDetached(["omarchy-launch-floating-terminal-with-presentation", "'" + bin + "'" + (args ? " " + args : "")])
    root.close()
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
    interval: Math.max(1, root.setting("autoTestMinutes", 0)) * 60000
    running: root.setting("autoTestMinutes", 0) > 0
    repeat: true
    onTriggered: root.runTest()
  }

  onOpenedChanged: if (opened) {
    now = Date.now()
    reload()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
    function run(): void { root.runTest() }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.barText
    active: root.running
    activeColor: root.accent
    tooltipText: ""
    onPressed: function(b) {
      if (b === Qt.RightButton) root.runTest()
      else if (b === Qt.MiddleButton) root.openTerminal("")
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(320))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(560))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onActivateRequested: root.runTest()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        var k = t.toLowerCase()
        if (k === "r") root.runTest()
        else if (k === "t") root.openTerminal("")
        else if (k === "h") root.openTerminal("history")
      }

      Column {
        id: column
        width: parent.width
        spacing: Style.space(16)

        PanelHero {
          width: parent.width
          title: "Speed"
          meta: root.running ? root.phaseLabel()
              : root.error !== "" ? root.error
              : root.last ? "Tested " + root.ago(root.last.timestamp)
              : "No tests yet"
          foreground: root.foreground
          fontFamily: root.fontFamily
          iconComponent: Component {
            Text {
              text: "󰓅"
              color: root.running ? root.accent : root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.display
            }
          }
          trailingControl: Component {
            PanelActionButton {
              iconText: root.running ? "󰔟" : "󰑐"
              tooltipText: root.running ? "Testing…" : "Run test (r)"
              foreground: root.foreground
              fontFamily: root.fontFamily
              enabled: !root.running
              onClicked: root.runTest()
            }
          }
        }

        // ── readout: download / upload, live while running ──
        RowLayout {
          width: parent.width
          spacing: Style.space(16)

          Repeater {
            model: [
              { key: "downloadMbps", label: "DOWNLOAD", phase: "download" },
              { key: "uploadMbps", label: "UPLOAD", phase: "upload" }
            ]
            ColumnLayout {
              required property var modelData
              readonly property var src: root.running ? root.live : root.last
              readonly property var value: src ? src[modelData.key] : null
              readonly property bool hot: root.running && root.phase === modelData.phase
              Layout.fillWidth: true
              Layout.preferredWidth: 1
              spacing: Style.space(2)

              Text {
                text: modelData.label
                color: hot ? root.accent : root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.letterSpacing: 1
              }
              Row {
                spacing: Style.space(6)
                Text {
                  id: big
                  text: root.num(value)
                  color: hot ? root.accent : (value === null ? root.faint : root.foreground)
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.displayLarge
                  font.weight: Font.DemiBold
                  font.features: ({ "tnum": 1 })
                }
                Text {
                  anchors.baseline: big.baseline
                  text: root.unit(value)
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                }
              }
            }
          }
        }

        // ── latency ──
        RowLayout {
          readonly property var src: root.running ? root.live : root.last
          width: parent.width
          spacing: Style.space(8)
          visible: src !== null && src.latencyMs !== null && src.latencyMs !== undefined

          Text {
            text: "LATENCY"
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            font.letterSpacing: 1
          }
          Text {
            Layout.fillWidth: true
            text: {
              var s = parent.src
              if (!s) return ""
              var t = Math.round(s.latencyMs) + " ms"
              if (s.loadedLatencyMs !== null && s.loadedLatencyMs !== undefined) t += "  →  " + Math.round(s.loadedLatencyMs) + " ms loaded"
              return t
            }
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            font.features: ({ "tnum": 1 })
            elide: Text.ElideRight
          }
          Rectangle {
            visible: !root.running && root.last && root.last.bufferbloat
            implicitWidth: gradeText.implicitWidth + Style.space(12)
            implicitHeight: gradeText.implicitHeight + Style.space(4)
            radius: height / 2
            color: "transparent"
            border.width: 1
            border.color: root.faint
            Text {
              id: gradeText
              anchors.centerIn: parent
              text: root.last && root.last.bufferbloat ? "bloat " + root.last.bufferbloat : ""
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
          }
        }

        PanelSeparator { foreground: root.foreground; visible: root.results.length > 1 }

        // ── history ──
        Column {
          id: histCol
          width: parent.width
          spacing: Style.space(8)
          visible: root.results.length > 1

          RowLayout {
            width: parent.width
            PanelSectionHeader {
              Layout.fillWidth: true
              text: "LAST " + root.results.length
              foreground: root.foreground
              fontFamily: root.fontFamily
            }
            Text {
              text: "avg " + root.num(root.avgDown) + "  ·  best " + root.num(root.bestDown)
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.features: ({ "tnum": 1 })
            }
          }

          Item {
            id: chart
            width: parent.width
            height: Style.space(44)
            readonly property int n: root.results.length
            readonly property real gap: Style.space(3)
            // Capped and right-aligned: a few results read as the start of a timeline, not blocks.
            readonly property real barW: n > 0 ? Math.min(Style.space(10), (width - gap * (n - 1)) / n) : 0

            Repeater {
              model: root.results
              Rectangle {
                required property var modelData
                required property int index
                readonly property bool latest: index === chart.n - 1
                x: chart.width - (chart.n - index) * (chart.barW + chart.gap) + chart.gap
                width: chart.barW
                height: Math.max(Style.space(2), chart.height * modelData.downloadMbps / root.bestDown)
                anchors.bottom: parent.bottom
                radius: Math.min(width / 2, Style.space(2))
                color: latest ? root.accent : (barMouse.containsMouse ? root.foreground : root.faint)

                MouseArea {
                  id: barMouse
                  anchors.fill: parent
                  hoverEnabled: true
                }
                PanelToolTip {
                  visible: barMouse.containsMouse
                  text: root.num(modelData.downloadMbps) + " Mbps · " + root.ago(modelData.timestamp)
                }
              }
            }
          }
        }

        // ── footer hints ──
        Text {
          width: parent.width
          text: "r  test     t  terminal     h  history"
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          horizontalAlignment: Text.AlignHCenter
        }
      }
    }
  }
}
