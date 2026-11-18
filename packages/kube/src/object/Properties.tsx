import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { TreeNode } from "@twigo/protocol";
import { Chip, PropertyList } from "@twigo/ui";
import { isFigures } from "../tabular";
import { treeGroup } from "./pageFilter";
import { usePropertyColumns } from "./propertyColumns";
import type { GroupFolds } from "./pageStates";

/**
 * A part of an object as a property grid: its plain fields as rows, then
 * each nested map as a group and each list of maps as a group of cards,
 * one per item. Groups below the second level start folded; while the page's
 * filter holds text, a group it narrowed draws open, and the person's choice
 * for a group is kept with that text.
 */
export function Properties({
  nodes,
  depth,
  path = [],
  groups,
}: {
  nodes: readonly TreeNode[];
  depth: number;
  /** The keys from the top of the tree down to `nodes`, which name its groups. */
  path?: readonly string[];
  groups: GroupFolds | undefined;
}) {
  const columns = usePropertyColumns();
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
        <PropertyList
          columns={columns}
          items={plain.map((node) => ({
            key: node.key,
            label: node.label,
            title: node.key,
            numeric: node.value.type === "scalar" && isFigures(node.value.text),
            value: (
              <span className="whitespace-pre-wrap">
                <Plain node={node} />
              </span>
            ),
          }))}
        />
      )}
      {nested.map((node) => (
        <Group
          key={node.key}
          node={node}
          depth={depth}
          path={[...path, node.key]}
          groups={groups}
        />
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
        <li key={index} className="max-w-full">
          <Chip>
            {item.value.type === "scalar" ? item.value.text : item.key}
          </Chip>
        </li>
      ))}
    </ul>
  );
}

function Group({
  node,
  depth,
  path,
  groups,
}: {
  node: TreeNode;
  depth: number;
  path: readonly string[];
  groups: GroupFolds | undefined;
}) {
  const [shown, setShown] = useState(depth < 2);
  const id = treeGroup(path);
  const open = groups ? groups.open(id, shown) : shown;
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
          if (groups) groups.set(id, !open);
          else setShown(!open);
        }}
        className="group/title flex h-6 items-center gap-1 self-start text-left text-xs font-semibold text-support"
      >
        {open ? (
          <ChevronDown className="size-3.5 group-hover/title:text-content" />
        ) : (
          <ChevronRight className="size-3.5 group-hover/title:text-content" />
        )}
        <span title={node.key}>{node.label}</span>
        {node.value.type === "list" && (
          <span className="ml-1 text-xs font-normal text-support">{count}</span>
        )}
      </button>
      {open && (
        <div className="mt-1 ml-1.5 border-l border-border-subtle pl-3">
          {node.value.type === "map" && (
            <Properties
              nodes={node.value.entries}
              depth={depth + 1}
              path={path}
              groups={groups}
            />
          )}
          {node.value.type === "list" && (
            <div className="flex flex-col gap-2">
              {node.value.items.map((item, index) => (
                <Card
                  key={index}
                  item={item}
                  index={index}
                  depth={depth}
                  path={[...path, item.key]}
                  groups={groups}
                />
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
  path,
  groups,
}: {
  item: TreeNode;
  index: number;
  depth: number;
  path: readonly string[];
  groups: GroupFolds | undefined;
}) {
  const named = item.key !== String(index);
  return (
    <div className="rounded-lg border border-border-subtle px-3 py-2">
      <div className="mb-1.5 text-xs text-support">
        {named ? (
          <span className="text-body font-medium text-content">{item.key}</span>
        ) : (
          `#${index + 1}`
        )}
      </div>
      {item.value.type === "map" ? (
        <Properties
          nodes={item.value.entries}
          depth={depth + 1}
          path={path}
          groups={groups}
        />
      ) : (
        <Plain node={item} />
      )}
    </div>
  );
}
