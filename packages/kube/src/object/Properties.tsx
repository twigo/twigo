import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { TreeNode } from "@twigo/protocol";

/** The label column of every property grid in the Overview, so they align. */
export const GRID =
  "grid grid-cols-[fit-content(14rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5";

/**
 * A part of an object as a property grid: its plain fields as rows, then
 * each nested map as a group and each list of maps as a group of cards,
 * one per item. Groups below the second level start folded.
 */
export function Properties({
  nodes,
  depth,
}: {
  nodes: readonly TreeNode[];
  depth: number;
}) {
  const plain = nodes.filter(
    (node) =>
      node.value.type === "scalar" ||
      (node.value.type === "list" &&
        node.value.items.every((item) => item.value.type === "scalar")),
  );
  const nested = nodes.filter((node) => !plain.includes(node));
  return (
    <div className="flex flex-col gap-2">
      {plain.length > 0 && (
        <dl className={GRID}>
          {plain.map((node) => (
            <div key={node.key} className="contents">
              <dt className="truncate text-muted-foreground" title={node.key}>
                {node.label}
              </dt>
              <dd className="min-w-0 break-words">
                <Plain node={node} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {nested.map((node) => (
        <Group key={node.key} node={node} depth={depth} />
      ))}
    </div>
  );
}

function Plain({ node }: { node: TreeNode }) {
  if (node.value.type === "scalar") return node.value.text;
  if (node.value.type !== "list") return null;
  return (
    <ul className="flex flex-wrap gap-1">
      {node.value.items.map((item, index) => (
        <li
          key={index}
          className="max-w-full rounded bg-muted px-1.5 py-px text-xs break-all"
        >
          {item.value.type === "scalar" ? item.value.text : item.key}
        </li>
      ))}
    </ul>
  );
}

function Group({ node, depth }: { node: TreeNode; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const count =
    node.value.type === "map"
      ? node.value.entries.length
      : node.value.type === "list"
        ? node.value.items.length
        : 0;
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
        className="flex h-6 items-center gap-1 self-start text-left font-medium hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="size-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 text-muted-foreground" />
        )}
        <span title={node.key}>{node.label}</span>
        {node.value.type === "list" && (
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            {count}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-1 ml-1.5 border-l border-border-subtle pl-3">
          {node.value.type === "map" && (
            <Properties nodes={node.value.entries} depth={depth + 1} />
          )}
          {node.value.type === "list" && (
            <div className="flex flex-col gap-2">
              {node.value.items.map((item, index) => (
                <Card key={index} item={item} index={index} depth={depth} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A list item: its name, or its position, over its own grid. */
function Card({
  item,
  index,
  depth,
}: {
  item: TreeNode;
  index: number;
  depth: number;
}) {
  const named = item.key !== String(index);
  return (
    <div className="rounded-md border border-border-subtle px-3 py-2">
      <div className="mb-1.5 text-xs text-muted-foreground">
        {named ? (
          <span className="text-[13px] font-medium text-foreground">
            {item.key}
          </span>
        ) : (
          `#${index + 1}`
        )}
      </div>
      {item.value.type === "map" ? (
        <Properties nodes={item.value.entries} depth={depth + 1} />
      ) : (
        <Plain node={item} />
      )}
    </div>
  );
}
