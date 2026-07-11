import { decodeText, tryPrettyJson, toHex } from "@twigo/utils";
import { codecDecode, codecEncode, type CodecId } from "@/lib/api";
import { useCodecs, type Schema } from "@/store/codecs";

export type BuiltinFormat = "json" | "text" | "hex";

export type DecodeTarget =
  | { kind: "builtin"; format: BuiltinFormat }
  | {
      kind: "codec";
      codec: CodecId;
      schemaId?: string;
      messageType?: string;
    };

export interface Decoded {
  text: string;
  language: "json" | "text";
}

export const CODEC_LABELS: Record<CodecId, string> = {
  protobuf: "Protobuf",
  msgpack: "MessagePack",
  cbor: "CBOR",
};

export function decodeBuiltin(
  payloadB64: string,
  format: BuiltinFormat,
): Decoded {
  if (format === "hex") return { text: toHex(payloadB64), language: "text" };
  if (format === "text")
    return { text: decodeText(payloadB64), language: "text" };
  const pretty = tryPrettyJson(payloadB64);
  return pretty !== null
    ? { text: pretty, language: "json" }
    : { text: decodeText(payloadB64), language: "text" };
}

function schemaArgs(target: Extract<DecodeTarget, { kind: "codec" }>): {
  codec: CodecId;
  descriptorSetB64?: string;
  messageType?: string;
} {
  const schema =
    target.codec === "protobuf"
      ? useCodecs.getState().schemaById(target.schemaId)
      : undefined;
  return {
    codec: target.codec,
    descriptorSetB64: schema?.descriptorSetB64,
    messageType: target.messageType,
  };
}

export async function decodePayload(
  payloadB64: string,
  target: DecodeTarget,
): Promise<Decoded> {
  if (target.kind === "builtin")
    return decodeBuiltin(payloadB64, target.format);
  const json = await codecDecode(payloadB64, schemaArgs(target));
  return { text: json, language: "json" };
}

export function encodePayload(
  json: string,
  target: Extract<DecodeTarget, { kind: "codec" }>,
): Promise<string> {
  return codecEncode(json, schemaArgs(target));
}

export function defaultTarget(
  connId: string | null,
  subject: string,
): DecodeTarget {
  const m = connId ? useCodecs.getState().resolve(connId, subject) : null;
  if (!m) return { kind: "builtin", format: "json" };
  return {
    kind: "codec",
    codec: m.codec,
    schemaId: m.schemaId,
    messageType: m.messageType,
  };
}

export function protobufTypeOptions(schema: Schema | undefined): string[] {
  return schema?.messageTypes ?? [];
}
