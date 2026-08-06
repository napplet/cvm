import Foundation
import Security

func fail(_ status: OSStatus) -> Never {
  exit(status == errSecSuccess ? 0 : 1)
}

guard CommandLine.arguments.count == 3 else {
  exit(1)
}

let service = CommandLine.arguments[1]
let account = CommandLine.arguments[2]
guard !service.isEmpty, !account.isEmpty else {
  exit(1)
}

let material = FileHandle.standardInput.readDataToEndOfFile()
guard !material.isEmpty, material.count <= 65_536 else {
  exit(1)
}

let query: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: service,
  kSecAttrAccount as String: account
]

let attributes: [String: Any] = [
  kSecValueData as String: material,
  kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
]

let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
if updateStatus == errSecSuccess {
  exit(0)
}
if updateStatus != errSecItemNotFound {
  fail(updateStatus)
}

var item = query
for (key, value) in attributes {
  item[key] = value
}
fail(SecItemAdd(item as CFDictionary, nil))
