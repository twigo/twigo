import { Copy, PanelRightClose } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUi } from "@/store/ui";

const payload = `{
  "id": "o_8421",
  "customer": "cus_1029",
  "total": 59.9,
  "currency": "USD",
  "items": [
    { "sku": "TWG-01", "qty": 1 }
  ]
}`;

export function DetailPanel() {
  const toggleDetail = useUi((s) => s.toggleDetail);
  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-border bg-panel">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Message
        </span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" title="Copy payload">
            <Copy />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Hide panel"
            onClick={toggleDetail}
          >
            <PanelRightClose />
          </Button>
        </div>
      </div>

      <div className="space-y-3 overflow-y-auto p-3">
        <Field label="Subject" value="orders.created" mono />
        <Field label="Received" value="12:04:31.221" mono />
        <Field label="Size" value="312 B" mono />
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Payload · JSON
          </p>
          <pre className="overflow-x-auto rounded-md border border-border bg-background p-2 font-mono text-xs leading-relaxed">
            {payload}
          </pre>
        </div>
      </div>
    </aside>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className={mono ? "font-mono text-xs" : "text-xs"}>{value}</span>
    </div>
  );
}
