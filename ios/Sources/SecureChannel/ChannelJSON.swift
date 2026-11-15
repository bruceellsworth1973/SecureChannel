import Foundation

public enum ChannelJSON: Codable, Equatable, Sendable, CustomStringConvertible,
    ExpressibleByNilLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByFloatLiteral, ExpressibleByStringLiteral, ExpressibleByArrayLiteral,
    ExpressibleByDictionaryLiteral
{
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([ChannelJSON])
    case object([String: ChannelJSON])

    public init(nilLiteral: ()) { self = .null }
    public init(booleanLiteral flag: Bool) { self = .bool(flag) }
    public init(integerLiteral amount: Int) { self = .number(Double(amount)) }
    public init(floatLiteral amount: Double) { self = .number(amount) }
    public init(stringLiteral text: String) { self = .string(text) }
    public init(arrayLiteral elements: ChannelJSON...) { self = .array(elements) }
    public init(dictionaryLiteral members: (String, ChannelJSON)...) {
        self = .object(Dictionary(members, uniquingKeysWith: { _, last in last }))
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let flag = try? container.decode(Bool.self) {
            self = .bool(flag)
        } else if let amount = try? container.decode(Double.self) {
            self = .number(amount)
        } else if let text = try? container.decode(String.self) {
            self = .string(text)
        } else if let elements = try? container.decode([ChannelJSON].self) {
            self = .array(elements)
        } else {
            self = .object(try container.decode([String: ChannelJSON].self))
        }
    }

    public static func decoded(from json: Data) throws -> ChannelJSON {
        try JSONDecoder().decode(ChannelJSON.self, from: json)
    }

    public var description: String {
        switch self {
        case .string(let text):
            return text
        default:
            return (try? encoded()).map { String(decoding: $0, as: UTF8.self) } ?? "\(self)"
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let flag): try container.encode(flag)
        case .number(let amount): try container.encode(amount)
        case .string(let text): try container.encode(text)
        case .array(let elements): try container.encode(elements)
        case .object(let members): try container.encode(members)
        }
    }

    public func encoded() throws -> Data {
        try JSONEncoder().encode(self)
    }

    public subscript(member: String) -> ChannelJSON? {
        guard case .object(let members) = self else { return nil }
        return members[member]
    }

    public subscript(position: Int) -> ChannelJSON? {
        guard case .array(let elements) = self, elements.indices.contains(position) else { return nil }
        return elements[position]
    }
}
