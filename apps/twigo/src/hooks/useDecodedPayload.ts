import { useEffect, useMemo, useState } from "react";
import {
  decodeBuiltin,
  decodePayload,
  type Decoded,
  type DecodeTarget,
} from "@/lib/codecs";

interface State {
  decoded: Decoded | null;
  loading: boolean;
  error: string | null;
}

interface Resolved {
  key: string;
  decoded: Decoded | null;
  error: string | null;
}

export function useDecodedPayload(
  payloadB64: string | null,
  target: DecodeTarget,
): State {
  const sync = useMemo(
    () =>
      payloadB64 !== null && target.kind === "builtin"
        ? decodeBuiltin(payloadB64, target.format)
        : null,
    [payloadB64, target],
  );

  const isCodec = payloadB64 !== null && target.kind === "codec";
  const key = useMemo(
    () => (isCodec ? `${payloadB64} ${JSON.stringify(target)}` : ""),
    [isCodec, payloadB64, target],
  );
  const [res, setRes] = useState<Resolved>({
    key: "",
    decoded: null,
    error: null,
  });

  useEffect(() => {
    if (!isCodec) return;
    let cancelled = false;
    decodePayload(payloadB64, target)
      .then((decoded) => {
        if (!cancelled) setRes({ key, decoded, error: null });
      })
      .catch((e: unknown) => {
        if (!cancelled) setRes({ key, decoded: null, error: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [isCodec, key, payloadB64, target]);

  if (sync) return { decoded: sync, loading: false, error: null };
  if (!isCodec) return { decoded: null, loading: false, error: null };
  if (res.key === key)
    return { decoded: res.decoded, loading: false, error: res.error };
  return { decoded: null, loading: true, error: null };
}
