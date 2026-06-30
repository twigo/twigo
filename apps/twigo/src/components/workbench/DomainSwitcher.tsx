import { ToggleGroup, ToggleGroupItem } from "@twigo/ui";
import { useUi } from "@/store/ui";
import { getDomains, getDefaultDomainId } from "@/shell/domains";

// Switches the active domain (NATS ↔ Kubernetes ↔ …). Domain-free: it renders
// whatever domains are registered, so the shell never hardcodes a product. Hides
// itself until a second domain exists, so a single-domain build is unchanged.
export function DomainSwitcher() {
  const activeDomain = useUi((s) => s.activeDomain);
  const setDomain = useUi((s) => s.setDomain);
  const domains = getDomains();
  if (domains.length < 2) return null;
  const current = activeDomain || getDefaultDomainId();

  return (
    <div className="px-2 pt-2">
      <ToggleGroup
        type="single"
        value={current}
        // Radix emits "" when the active item is re-clicked; keep the current
        // domain rather than clearing it (a domain must always be selected).
        onValueChange={(v) => v && setDomain(v)}
        className="w-full rounded-md border border-input bg-background p-0.5"
        aria-label="Switch domain"
      >
        {domains.map(({ id, title, icon: Icon }) => (
          <ToggleGroupItem
            key={id}
            value={id}
            aria-label={title}
            className="flex h-7 flex-1 items-center justify-center gap-1.5"
          >
            <Icon className="size-3.5" />
            <span className="truncate">{title}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
