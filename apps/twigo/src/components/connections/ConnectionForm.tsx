import { useEffect, useState } from "react";
import { FolderOpen, Loader2 } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Button,
  Input,
  Switch,
  FieldGrid,
  FormField,
} from "@twigo/ui";
import { Select } from "@/components/editor/jetstream/form";
import {
  getContext,
  saveContext,
  deleteContext,
  type ContextInput,
} from "@/lib/api";
import { useSettings } from "@/store/settings";
import { useConnections } from "@/store/connections";
import { useToasts } from "@/store/toasts";

const DEMO_NAME = "demo.nats.io";
const AUTH_METHODS = [
  "none",
  "token",
  "user/password",
  "creds",
  "nkey",
] as const;
type AuthMethod = (typeof AUTH_METHODS)[number];

// Mirrors the backend's valid_context_name (the name becomes <name>.json).
function nameError(name: string): string | null {
  const n = name.trim();
  if (!n) return "Name is required";
  if (n === DEMO_NAME) return "Reserved name";
  if (n.includes("..") || !/^[A-Za-z0-9._-]+$/.test(n))
    return "Use letters, digits, . _ - only";
  return null;
}

export function ConnectionForm({
  editName,
  onClose,
}: {
  // null/undefined = create a new context; a name = edit that context.
  editName?: string | null;
  onClose: () => void;
}) {
  const dir = useSettings((s) => s.contextDir) ?? null;
  const reload = useConnections((s) => s.load);
  const isEdit = !!editName;

  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [name, setName] = useState(editName ?? "");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [auth, setAuth] = useState<AuthMethod>("none");
  const [token, setToken] = useState("");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [creds, setCreds] = useState("");
  const [nkey, setNkey] = useState("");
  const [ca, setCa] = useState("");
  const [cert, setCert] = useState("");
  const [key, setKey] = useState("");
  const [tlsFirst, setTlsFirst] = useState(false);

  useEffect(() => {
    if (!editName) return;
    let cancelled = false;
    void getContext(dir, editName)
      .then((d) => {
        if (cancelled) return;
        setUrl(d.url);
        setDescription(d.description ?? "");
        setToken(d.token ?? "");
        setUser(d.user ?? "");
        setPassword(d.password ?? "");
        setCreds(d.creds ?? "");
        setNkey(d.nkey ?? "");
        setCa(d.ca ?? "");
        setCert(d.cert ?? "");
        setKey(d.key ?? "");
        setTlsFirst(d.tlsFirst);
        // Same precedence as the backend's auth_method().
        setAuth(
          d.creds
            ? "creds"
            : d.nkey
              ? "nkey"
              : d.token
                ? "token"
                : d.user
                  ? "user/password"
                  : "none",
        );
      })
      .catch((e: unknown) => {
        useToasts
          .getState()
          .push("error", `Couldn't load ${editName}: ${String(e)}`);
        onClose();
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editName, dir, onClose]);

  const nameErr = isEdit ? null : nameError(name);
  const valid = !nameErr && url.trim() !== "" && !loading;

  const submit = async () => {
    if (!valid) return;
    // Send only the active auth method's fields; the backend drops the rest, so
    // switching auth clears the now-stale secret.
    const input: ContextInput = {
      url: url.trim(),
      description: description.trim() || undefined,
      tlsFirst,
      ca: ca.trim() || undefined,
      cert: cert.trim() || undefined,
      key: key.trim() || undefined,
      ...(auth === "token" ? { token: token || undefined } : {}),
      ...(auth === "user/password"
        ? { user: user || undefined, password: password || undefined }
        : {}),
      ...(auth === "creds" ? { creds: creds.trim() || undefined } : {}),
      ...(auth === "nkey" ? { nkey: nkey.trim() || undefined } : {}),
    };
    setSaving(true);
    try {
      await saveContext(dir, name.trim(), input);
      await reload();
      useToasts.getState().push("success", `Saved ${name.trim()}`);
      onClose();
    } catch (e) {
      useToasts.getState().push("error", `Couldn't save: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    if (!editName) return;
    setSaving(true);
    try {
      await deleteContext(dir, editName);
      await reload();
      useToasts.getState().push("success", `Deleted ${editName}`);
      onClose();
    } catch (e) {
      useToasts.getState().push("error", `Couldn't delete: ${String(e)}`);
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto p-5">
        <DialogTitle className="text-sm font-semibold">
          {isEdit ? `Edit ${editName}` : "New connection"}
        </DialogTitle>
        <DialogDescription className="mt-1 text-xs text-muted-foreground">
          Saved as a nats context in {dir ?? "~/.config/nats/context"} - fully
          compatible with the nats CLI.
        </DialogDescription>

        {loading ? (
          <div className="flex items-center gap-2 py-8 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : (
          <FieldGrid className="mt-4">
            <FormField
              label="Name"
              hint={
                nameErr ?? (isEdit ? "Renaming isn't supported" : undefined)
              }
            >
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isEdit}
                autoFocus={!isEdit}
                spellCheck={false}
                placeholder="prod-eu"
                className="h-7 font-mono text-xs"
              />
            </FormField>

            <FormField label="URL">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                autoFocus={isEdit}
                spellCheck={false}
                placeholder="nats://localhost:4222"
                className="h-7 font-mono text-xs"
              />
            </FormField>

            <FormField label="Description" hint="Optional.">
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Production EU cluster"
                className="h-7 text-xs"
              />
            </FormField>

            <FormField
              label="Auth"
              hint="File-based (creds / nkey) is recommended for real servers."
            >
              <Select
                value={auth}
                onChange={(v) => setAuth(v as AuthMethod)}
                options={[...AUTH_METHODS]}
              />
            </FormField>

            {auth === "token" && (
              <FormField label="Token">
                <Input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  spellCheck={false}
                  className="h-7 font-mono text-xs"
                />
              </FormField>
            )}

            {auth === "user/password" && (
              <>
                <FormField label="User">
                  <Input
                    value={user}
                    onChange={(e) => setUser(e.target.value)}
                    spellCheck={false}
                    className="h-7 font-mono text-xs"
                  />
                </FormField>
                <FormField label="Password">
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    spellCheck={false}
                    className="h-7 font-mono text-xs"
                  />
                </FormField>
              </>
            )}

            {auth === "creds" && (
              <FormField label="Creds file">
                <FilePath value={creds} onChange={setCreds} />
              </FormField>
            )}

            {auth === "nkey" && (
              <FormField
                label="NKey"
                hint="Seed string or a path to a seed file."
              >
                <FilePath value={nkey} onChange={setNkey} />
              </FormField>
            )}

            <FormField label="CA cert" hint="Optional - for a custom CA (TLS).">
              <FilePath value={ca} onChange={setCa} />
            </FormField>
            <FormField label="Client cert" hint="Optional - mTLS.">
              <FilePath value={cert} onChange={setCert} />
            </FormField>
            <FormField label="Client key" hint="Optional - mTLS.">
              <FilePath value={key} onChange={setKey} />
            </FormField>

            <FormField
              label="TLS first"
              hint="Handshake before the server sends INFO."
            >
              <Switch checked={tlsFirst} onCheckedChange={setTlsFirst} />
            </FormField>
          </FieldGrid>
        )}

        <DialogFooter>
          {confirmDelete ? (
            <div className="flex w-full items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                Delete {editName}? Removes the context file.
              </span>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={saving}
                  onClick={() => void doDelete()}
                >
                  Delete
                </Button>
              </div>
            </div>
          ) : (
            <>
              {isEdit && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmDelete(true)}
                  className="mr-auto text-error hover:text-error"
                >
                  Delete
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="brand"
                size="sm"
                disabled={!valid || saving}
                onClick={() => void submit()}
              >
                {saving
                  ? "Saving…"
                  : isEdit
                    ? "Save changes"
                    : "Create connection"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// A file path with a native picker. The chosen path is stored as text in the
// context (read at connect time), so no path crosses a privileged FS command.
function FilePath({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const browse = async () => {
    const picked = await openDialog({ multiple: false, directory: false });
    if (typeof picked === "string") onChange(picked);
  };
  return (
    <div className="flex items-center gap-1.5">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        placeholder="/path/to/file"
        className="h-7 flex-1 font-mono text-xs"
      />
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void browse()}
        className="h-7 shrink-0 px-2"
      >
        <FolderOpen className="size-3.5" />
      </Button>
    </div>
  );
}
