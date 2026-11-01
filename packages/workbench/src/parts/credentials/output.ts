import type { ExecPlugin } from "@twigo/protocol";

/**
 * What a sign-in plugin's stderr offers the person: the link to open and
 * the code to enter, in the forms the plugins print them (Azure/kubelogin's
 * Entra line, int128/kubelogin, pinniped and tsh, read in their sources at
 * their latest releases, 2026-11-01).
 */
export interface SignInHints {
  readonly url?: string;
  readonly code?: string;
}

const CODE = [
  /enter the code (\S+?)[.,]?(?:\s|$)/i,
  /enter the following code when asked in your browser: (\S+)/i,
];
const URL_PATTERN = /https?:\/\/[^\s'"<>]+/;

export function hints(output: string): SignInHints {
  const text = plain(output);
  const found = URL_PATTERN.exec(text)?.[0].replace(/[.,;)]+$/, "");
  const url = found !== undefined && openable(found) ? found : undefined;
  const code = CODE.map((pattern) => pattern.exec(text)?.[1]).find(Boolean);
  return { url, code };
}

/**
 * A sign-in page: https, or the plugin's own server on this machine, as
 * int128/kubelogin, pinniped and tsh run one. A user part, as in
 * `http://localhost:1@example.com`, would name another host.
 */
function openable(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "") return false;
  return (
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"))
  );
}

/** Without terminal escapes and carriage returns: tsh ends lines with `\r\n`. */
export function plain(output: string): string {
  let text = "";
  for (let i = 0; i < output.length; i++) {
    const char = output.charAt(i);
    if (char === "\r") continue;
    if (char === "\u001b" && output.charAt(i + 1) === "[") {
      i += 2;
      while (i < output.length && !/[@-~]/.test(output.charAt(i))) i++;
      continue;
    }
    text += char;
  }
  return text;
}

/** The command a failed plugin's message asks the person to run in a terminal. */
export function remedy(output: string, plugin: ExecPlugin): string | undefined {
  const text = plain(output);
  if (/run aws sso login/i.test(text)) {
    const profile =
      flag(plugin.args, "--profile") ??
      plugin.env.find((v) => v.name === "AWS_PROFILE")?.value;
    return profile ? `aws sso login --profile ${profile}` : "aws sso login";
  }
  if (/'az login'/i.test(text)) return "az login";
  if (/tsh login/i.test(text)) return "tsh login";
  return undefined;
}

function flag(args: readonly string[], name: string): string | undefined {
  const at = args.findIndex(
    (arg) => arg === name || arg.startsWith(`${name}=`),
  );
  if (at < 0) return undefined;
  const arg = args[at] ?? "";
  return arg.includes("=") ? arg.slice(name.length + 1) : args[at + 1];
}
