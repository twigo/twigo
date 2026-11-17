import type { ObjectSnapshot } from "@twigo/protocol";
import { TabBar } from "@twigo/ui";
import { OBJECT_TABS, type ObjectTab } from "./tabs";

/** Warning events of the object, from its Overview or its Events view, whichever came. */
function warningCount({ overview, events }: ObjectSnapshot): number {
  const listed =
    events?.events ??
    overview?.sections
      .flatMap((section) => section.blocks)
      .flatMap((block) => (block.type === "events" ? block.events : []));
  return (listed ?? []).filter((event) => event.type === "Warning").length;
}

/**
 * The views of an object as one row (ARCHITECTURE 4.3), at the top of its
 * content in the details and in an editor alike: Overview, YAML, Events with
 * its warnings counted, and Related.
 */
export function ObjectViews({
  tab,
  snapshot,
  onChange,
}: {
  tab: ObjectTab;
  snapshot: ObjectSnapshot;
  onChange: (tab: ObjectTab) => void;
}) {
  const warnings = warningCount(snapshot);
  return (
    <TabBar
      label="Views of the object"
      tabs={OBJECT_TABS.map(({ id, title }) => ({
        value: id,
        label: title,
        ...(id === "events" && { count: warnings, warn: true }),
      }))}
      value={tab}
      onChange={onChange}
      className="shadow-[inset_0_-1px_0_var(--border-subtle)]"
    />
  );
}
