/** A container image reference in the parts that read apart. */
interface ImageParts {
  /** The registry and the path before the name, with their last `/`: `docker.io/kindest/`. */
  readonly path: string;
  /** The name with its tag: `local-path-helper:v20260131-7181c60a`. */
  readonly name: string;
  /** The digest folded to its first hex digits: `@sha256:7181…`; empty without one. */
  readonly digest: string;
}

const DIGEST_DIGITS = 4;

export function splitImage(reference: string): ImageParts {
  const at = reference.indexOf("@");
  const named = at < 0 ? reference : reference.slice(0, at);
  const slash = named.lastIndexOf("/") + 1;
  return {
    path: named.slice(0, slash),
    name: named.slice(slash),
    digest: at < 0 ? "" : foldDigest(reference.slice(at)),
  };
}

function foldDigest(digest: string): string {
  const hexFrom = digest.indexOf(":") + 1;
  return digest.length - hexFrom > DIGEST_DIGITS
    ? `${digest.slice(0, hexFrom + DIGEST_DIGITS)}…`
    : digest;
}
