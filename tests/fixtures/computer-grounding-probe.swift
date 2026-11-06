import AppKit
import WebKit

// A disposable, background-only window. Its receipt is an independent click oracle.
let receipt = CommandLine.arguments[1]
let command = CommandLine.arguments[2]
var hits = 0
var buttonHits = 0
var submissions = 0
var ready = ProcessInfo.processInfo.environment["MIMI_PROBE_SURFACE"] != "web"
let statusLabel = NSTextField(labelWithString: "Canvas clicks: 0; Button clicks: 0")
var lastPoint: [String: Double] = [:]
var events: [[String: Any]] = []
func logEvent(_ stage: String, _ event: NSEvent) {
  events.append(["stage": stage, "type": event.type.rawValue, "timestamp": event.timestamp,
    "eventNumber": event.eventNumber, "clickCount": event.clickCount,
    "x": event.locationInWindow.x, "y": event.locationInWindow.y])
}
class ProbeApplication: NSApplication {
  override func sendEvent(_ event: NSEvent) {
    if event.type == .leftMouseDown || event.type == .leftMouseUp { logEvent("application", event) }
    let keyboard = event.type == .keyDown || event.type == .keyUp
    if keyboard { events.append(["stage": "keyboard", "type": event.type.rawValue, "keyCode": event.keyCode,
      "characters": event.characters ?? "", "modifiers": event.modifierFlags.rawValue]) }
    super.sendEvent(event)
    if keyboard { report() }
  }
}
var lastCommand = ""
let app = ProbeApplication.shared
// A normal app identity is needed by the driver's running-app discovery.
// orderBack below keeps this test window from taking the user's focus.
app.setActivationPolicy(.regular)
let inputField = NSTextField(string: "Eminem")
let menu = NSMenu()
let edit = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
let editMenu = NSMenu(title: "Edit")
editMenu.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
edit.submenu = editMenu
menu.addItem(edit)
app.mainMenu = menu
let window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 600, height: 400),
  styleMask: [.titled], backing: .buffered, defer: false)
window.title = "Mimi Grounding Probe"
func report() {
  statusLabel.stringValue = "Canvas clicks: \(hits); Button clicks: \(buttonHits)"
  let titleHeight = window.frame.height - window.contentView!.frame.height
  let data: [String: Any] = ["hits": hits, "width": window.frame.width,
    "height": window.frame.height, "x": 100, "y": titleHeight + 100, "lastPoint": lastPoint, "events": events, "buttonHits": buttonHits, "ready": ready,
    "textValue": inputField.stringValue, "submissions": submissions]
  try! JSONSerialization.data(withJSONObject: data).write(to: URL(fileURLWithPath: receipt), options: .atomic)
}
class ProbeView: NSView {
  override var isFlipped: Bool { true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func draw(_ dirtyRect: NSRect) {
    NSColor.white.setFill(); bounds.fill()
    NSColor.systemBlue.setFill(); NSRect(x: 60, y: 60, width: 80, height: 80).fill()
    ("Click target" as NSString).draw(at: NSPoint(x: 60, y: 150), withAttributes: nil)
  }
  override func mouseDown(with event: NSEvent) {
    logEvent("view_down", event)
    let point = convert(event.locationInWindow, from: nil)
    lastPoint = ["x": point.x, "y": point.y]
    if NSRect(x: 60, y: 60, width: 80, height: 80).contains(point) { hits += 1 }
    report()
  }
  override func mouseUp(with event: NSEvent) { logEvent("view_up", event); report() }
}
window.contentView = ProbeView(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
class ButtonController: NSObject, NSTextFieldDelegate {
  @objc func click(_ sender: Any?) { buttonHits += 1; report() }
  @objc func submit(_ sender: Any?) { submissions += 1; report() }
  func controlTextDidChange(_ obj: Notification) { report() }
}
let controller = ButtonController()
inputField.frame = NSRect(x: 60, y: 270, width: 340, height: 30)
inputField.setAccessibilityIdentifier("search-field")
inputField.delegate = controller
inputField.target = controller
inputField.action = #selector(ButtonController.submit(_:))
window.contentView!.addSubview(inputField)
let nativeButton = NSButton(title: "Native Click", target: controller, action: #selector(ButtonController.click(_:)))
nativeButton.frame = NSRect(x: 240, y: 60, width: 140, height: 80)
nativeButton.setAccessibilityIdentifier("native-click")
window.contentView!.addSubview(nativeButton)
statusLabel.frame = NSRect(x: 60, y: 200, width: 500, height: 30)
statusLabel.setAccessibilityIdentifier("click-status")
window.contentView!.addSubview(statusLabel)
class WebReceipt: NSObject, WKScriptMessageHandler {
  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let event = message.body as? [String: Any], let stage = event["stage"] as? String else { return }
    if stage == "ready" { ready = true; report(); return }
    events.append(event)
    if stage == "view_down" { hits += 1 }
    if stage == "button_click" { buttonHits += 1 }
    report()
  }
}
let webReceipt = WebReceipt()
if ProcessInfo.processInfo.environment["MIMI_PROBE_SURFACE"] == "web" {
  let configuration = WKWebViewConfiguration()
  configuration.userContentController.add(webReceipt, name: "probe")
  let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 600, height: 400), configuration: configuration)
  window.contentView = web
  web.loadHTMLString("""
    <html><body style="margin:0;background:white;font:16px sans-serif">
    <div id="canvas" style="position:absolute;left:60px;top:60px;width:80px;height:80px;background:#0783fa"></div>
    <span style="position:absolute;left:60px;top:150px">Click target</span>
    <button id="native" style="position:absolute;left:240px;top:60px;width:140px;height:80px">Native Click</button>
    <p id="status" style="position:absolute;left:60px;top:200px">Canvas clicks: 0; Button clicks: 0</p>
    <script>
    let canvasClicks=0,buttonClicks=0;
    const send=(stage,event)=>{window.webkit.messageHandlers.probe.postMessage({stage,type:event.type,
      timestamp:event.timeStamp,x:event.offsetX,y:event.offsetY,clickCount:event.detail});
      document.getElementById('status').textContent=`Canvas clicks: ${canvasClicks}; Button clicks: ${buttonClicks}`;};
    document.getElementById('canvas').onmousedown=e=>{canvasClicks++;send('view_down',e)};
    document.getElementById('canvas').onmouseup=e=>send('view_up',e);
    document.getElementById('native').onclick=e=>{buttonClicks++;send('button_click',e)};
    window.webkit.messageHandlers.probe.postMessage({stage:'ready'});
    </script></body></html>
    """, baseURL: nil)
}
window.orderBack(nil)
report()
let timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
  guard let value = try? String(contentsOfFile: command, encoding: .utf8), value != lastCommand else { return }
  lastCommand = value
  if value == "move" { window.setFrameOrigin(NSPoint(x: window.frame.minX + 240, y: window.frame.minY + 80)); report() }
  if value == "control" {
    if let web = window.contentView as? WKWebView {
      // Calibrate only the DOM event counter; the measured trials still use Driver input.
      web.evaluateJavaScript("for (const type of ['mousedown','mouseup']) document.getElementById('canvas').dispatchEvent(new MouseEvent(type, {bubbles:true, detail:1}));", completionHandler: nil)
      return
    }
    for type: NSEvent.EventType in [.leftMouseDown, .leftMouseUp] {
      let event = NSEvent.mouseEvent(with: type, location: NSPoint(x: 100, y: 300), modifierFlags: [],
        timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
        context: nil, eventNumber: 12345, clickCount: 1, pressure: 1)!
      app.sendEvent(event)
    }
    report()
  }
}
app.run()
