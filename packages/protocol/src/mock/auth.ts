import { IpcError } from "../error";
import type {
  ContextAuth,
  ExecPlugin,
  ExecReview,
  PluginStatus,
} from "../generated";

/** Pins the credentials of `prod-eu`, the space that opens first. */
export type AuthScenario =
  "review" | "untrusted" | "deviceCode" | "browser" | "pluginFailed";

export const AUTH_SCENARIOS: readonly AuthScenario[] = [
  "review",
  "untrusted",
  "deviceCode",
  "browser",
  "pluginFailed",
];

export function isAuthScenario(scenario: string): scenario is AuthScenario {
  return (AUTH_SCENARIOS as readonly string[]).includes(scenario);
}

/**
 * The exec blocks the plugins' own setup commands write: `kubelogin
 * convert-kubeconfig` (Azure/kubelogin v0.2.22), int128/kubelogin's setup
 * guide (v1.36.4), `aws eks update-kubeconfig` (aws-cli 2.39.3) and `tsh kube
 * login` (Teleport v18.10.0).
 */
const AZURE: ExecPlugin = {
  command: "kubelogin",
  args: [
    "get-token",
    "--login",
    "devicecode",
    "--server-id",
    "6dae42f8-4368-4678-94ff-3960e28e3630",
    "--client-id",
    "80faf920-1908-4b52-b5ef-a8e7bedfc67a",
    "--tenant-id",
    "4c3e5b0a-7f1d-4e8a-9b6c-2d1f0e9a8b7c",
    "--environment",
    "AzurePublicCloud",
  ],
  env: [],
  digest: "azure-prod-eu",
  signsIn: true,
};

const OIDC: ExecPlugin = {
  command: "kubectl",
  args: [
    "oidc-login",
    "get-token",
    "--oidc-issuer-url=https://dex.staging.example.com",
    "--oidc-client-id=twigo",
  ],
  env: [],
  digest: "oidc-staging",
  signsIn: true,
};

const AWS: ExecPlugin = {
  command: "aws",
  args: [
    "--region",
    "eu-west-1",
    "eks",
    "get-token",
    "--cluster-name",
    "dev",
    "--output",
    "json",
  ],
  env: [{ name: "AWS_PROFILE", value: "dev-admin" }],
  digest: "aws-dev",
  signsIn: false,
};

const TSH: ExecPlugin = {
  command: "/usr/local/bin/tsh",
  args: [
    "kube",
    "credentials",
    "--kube-cluster=qa",
    "--teleport-cluster=teleport.example.com",
    "--proxy=teleport.example.com:443",
  ],
  env: [],
  digest: "tsh-qa",
  signsIn: true,
};

/**
 * What each plugin prints on stderr while it waits for the person: the
 * Entra device-code line as Rancher's copy of it reads (rancher v2.15.3),
 * nothing from int128/kubelogin once the browser opens, and tsh's link.
 */
const OUTPUT: Readonly<Record<string, string>> = {
  [AZURE.digest]:
    "To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code F3JQ7K9PL to authenticate.\n",
  [OIDC.digest]: "",
  [TSH.digest]:
    "If browser window does not open automatically, open it by clicking on the link:\r\n http://127.0.0.1:53712/2c9b0d6e-0d1a-4f0e-9a51-6b8f1c1c2e3a\r\n",
  [AWS.digest]: "",
};

/** aws-cli 2.39.3 when the SSO session has expired, exit code 255. */
const AWS_SSO_EXPIRED =
  "\naws: [ERROR]: The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile.\n";

const SIGN_IN_MS = 6000;
const UNATTENDED_MS = 800;

interface Entry {
  plugin: ExecPlugin;
  status: PluginStatus;
  timer?: ReturnType<typeof setTimeout>;
}

const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

/**
 * The credential commands of the mock backend. It knows no window focus,
 * so it never sends `waiting`.
 */
export class MockAuth {
  readonly #entries = new Map<string, Entry>();
  readonly #trusted = new Set<string>();
  readonly #watchers = new Map<string, Set<(auth: ContextAuth) => void>>();
  #reviewed: boolean;

  constructor(scenario: AuthScenario | undefined) {
    const plugins: Record<string, ExecPlugin> = {
      "prod-eu": scenario === "browser" ? OIDC : AZURE,
      staging: OIDC,
      dev: AWS,
      qa: TSH,
    };
    if (scenario === "pluginFailed") plugins["prod-eu"] = AWS;
    for (const [context, plugin] of Object.entries(plugins)) {
      this.#entries.set(context, {
        plugin,
        status: { state: "ready", expires: inAnHour() },
      });
      if (scenario !== "review") this.#trusted.add(plugin.digest);
    }
    this.#reviewed = scenario !== "review";
    const prod = this.#entry("prod-eu");
    switch (scenario) {
      case "review":
      case "untrusted":
        this.#trusted.delete(prod.plugin.digest);
        prod.status = { state: "idle" };
        break;
      case "deviceCode":
      case "browser":
        prod.status = {
          state: "running",
          since: new Date().toISOString(),
          output: OUTPUT[prod.plugin.digest] ?? "",
        };
        break;
      case "pluginFailed":
        prod.status = {
          state: "failed",
          error: "exec: executable aws failed with exit code 255",
          output: AWS_SSO_EXPIRED,
          installHint: null,
        };
        break;
      case undefined:
        break;
    }
  }

  watch(context: string, onMessage: (auth: ContextAuth) => void): ContextAuth {
    let watchers = this.#watchers.get(context);
    if (!watchers) {
      watchers = new Set();
      this.#watchers.set(context, watchers);
    }
    watchers.add(onMessage);
    return this.#auth(context);
  }

  signIn(context: string): null {
    const entry = this.#trustedEntry(context);
    if (entry.status.state === "running") return null;
    const since = new Date().toISOString();
    entry.status = { state: "running", since, output: "" };
    this.#emit(context);
    const signsIn = entry.plugin.signsIn;
    entry.timer = setTimeout(
      () => {
        entry.status = {
          state: "running",
          since,
          output: OUTPUT[entry.plugin.digest] ?? "",
        };
        this.#emit(context);
        entry.timer = setTimeout(
          () => {
            entry.status = { state: "ready", expires: inAnHour() };
            this.#emit(context);
          },
          signsIn ? SIGN_IN_MS : 0,
        );
      },
      signsIn ? 300 : UNATTENDED_MS,
    );
    return null;
  }

  cancel(context: string): null {
    const entry = this.#trustedEntry(context);
    if (entry.status.state !== "running") return null;
    clearTimeout(entry.timer);
    entry.status = {
      state: "failed",
      error: `exec: ${entry.plugin.command} was cancelled`,
      output: entry.status.output,
      installHint: null,
    };
    this.#emit(context);
    return null;
  }

  /**
   * A request's credential: an idle plugin starts a run, as in Rust, but the
   * request fails at once where Rust's would wait for the run; the
   * workbench asks again once the credential is ready.
   */
  check(context: string): void {
    const auth = this.#auth(context);
    if (auth.state === "untrusted") this.#trustedEntry(context);
    if (auth.state !== "plugin" || auth.status.state === "ready") return;
    if (auth.status.state === "idle") this.signIn(context);
    throw new IpcError(
      "unauthorized",
      `${auth.plugin.command} gave no credential yet`,
    );
  }

  review(): ExecReview {
    const plugins = new Map<
      string,
      { plugin: ExecPlugin; contexts: string[] }
    >();
    for (const [context, { plugin }] of this.#entries) {
      if (this.#trusted.has(plugin.digest)) continue;
      const reviewed = plugins.get(plugin.digest);
      if (reviewed) reviewed.contexts.push(context);
      else plugins.set(plugin.digest, { plugin, contexts: [context] });
    }
    return { reviewed: this.#reviewed, plugins: [...plugins.values()] };
  }

  trust(digests: readonly string[]): null {
    for (const digest of digests) this.#trusted.add(digest);
    this.#reviewed = true;
    for (const context of this.#watchers.keys()) this.#emit(context);
    return null;
  }

  #auth(context: string): ContextAuth {
    const entry = this.#entries.get(context);
    if (!entry) return { state: "none" };
    if (!this.#trusted.has(entry.plugin.digest)) {
      return { state: "untrusted", plugin: entry.plugin };
    }
    return { state: "plugin", plugin: entry.plugin, status: entry.status };
  }

  #entry(context: string): Entry {
    const entry = this.#entries.get(context);
    if (!entry) {
      throw new IpcError(
        "notFound",
        `the context "${context}" has no credential plugin`,
      );
    }
    return entry;
  }

  #trustedEntry(context: string): Entry {
    const entry = this.#entry(context);
    if (!this.#trusted.has(entry.plugin.digest)) {
      throw new IpcError(
        "unauthorized",
        `Twigo runs ${entry.plugin.command} for the context "${context}" only once you trust it`,
      );
    }
    return entry;
  }

  #emit(context: string): void {
    const auth = this.#auth(context);
    for (const watcher of this.#watchers.get(context) ?? []) watcher(auth);
  }
}
