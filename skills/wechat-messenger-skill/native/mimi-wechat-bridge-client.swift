import CoreFoundation
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("\(message)\n".utf8))
  exit(1)
}

guard CommandLine.arguments.count == 2 else {
  fail("usage: mimi-wechat-bridge-client '<json>'")
}
let name = "com.mimi.wechat.bridge.\(getuid())" as CFString
guard let port = CFMessagePortCreateRemote(kCFAllocatorDefault, name) else {
  fail("bridge_unavailable")
}
guard let request = CommandLine.arguments[1].data(using: .utf8) else {
  fail("invalid_request")
}
var response: Unmanaged<CFData>?
let status = CFMessagePortSendRequest(
  port,
  1,
  request as CFData,
  5,
  5,
  CFRunLoopMode.defaultMode.rawValue,
  &response
)
guard status == kCFMessagePortSuccess, let data = response?.takeRetainedValue() else {
  fail("bridge_request_failed:\(status)")
}
FileHandle.standardOutput.write(data as Data)
FileHandle.standardOutput.write(Data("\n".utf8))
