import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { IconButton, Popover, PopoverContent, PopoverTrigger } from "@twigo/ui";
import { useChanges, type EditorProps } from "@twigo/workbench";
import { EditActions } from "./actions";
import type { EditServices } from "./services";
import { variants } from "./variants";

/**
 * "Changed on server" as a mark in the editor's tab, for the variant that
 * keeps it out of the editor: its popover says it and offers the choices.
 */
export function ChangedMarker({
  uri,
  edits,
}: EditorProps & { edits: EditServices }) {
  useChanges(edits.copies.changes);
  const [open, setOpen] = useState(false);
  if (variants().changed !== "marker" || !edits.copies.serverChanged(uri))
    return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <span className="flex">
          <IconButton
            icon={TriangleAlert}
            label="Changed on server"
            className="text-warn-foreground"
            onClick={() => {
              setOpen((was) => !was);
            }}
          />
        </span>
      </PopoverTrigger>
      <PopoverContent className="flex w-72 flex-col gap-2 p-3 text-xs">
        <p className="font-medium">Changed on server</p>
        <p className="text-muted-foreground">
          The object changed after you opened it. Your text stays as it is until
          you choose.
        </p>
        <EditActions edits={edits} uri={uri} menus={["edit/changed"]} />
      </PopoverContent>
    </Popover>
  );
}
