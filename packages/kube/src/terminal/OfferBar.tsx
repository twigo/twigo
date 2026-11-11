import { FileInput } from "lucide-react";
import { Button } from "@twigo/ui";
import { useChanges } from "@twigo/workbench";
import { OfferDetail } from "./OfferDetail";
import { describeOffer } from "./offerWords";
import { hostOf, offersInBars, type KubeconfigOffers } from "./offers";
import type { TerminalTabs } from "./tabs";

/** The offers that came from a terminal, in a bar over it, in `offer:bar`. */
export function OfferBar({
  uri,
  tabs,
  offers,
}: {
  uri: string;
  tabs: TerminalTabs;
  offers: KubeconfigOffers;
}) {
  useChanges(offers.changes);
  useChanges(tabs.changes);
  if (!offersInBars()) return null;
  return offers.offers
    .filter((offer) => hostOf(offer, tabs) === uri)
    .map((offer) => {
      const words = describeOffer(offer);
      const busy = offers.answering(offer.id);
      return (
        <div
          key={offer.id}
          role="status"
          className="flex flex-none items-start gap-2 border-b border-border-subtle bg-brand/8 py-1.5 pr-2 pl-3 text-xs"
        >
          <FileInput
            aria-hidden
            className="mt-0.5 size-3.5 shrink-0 text-brand"
          />
          <div className="grid min-w-0 flex-1 gap-1.5">
            <span className="font-medium">{words.title}</span>
            <OfferDetail words={words} />
          </div>
          <div className="flex shrink-0 gap-1.5">
            <Button
              size="sm"
              variant="brand"
              disabled={busy}
              onClick={() => {
                void offers.answer(offer.id, "move");
              }}
            >
              {words.move}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                void offers.answer(offer.id, "dismiss");
              }}
            >
              Dismiss
            </Button>
          </div>
        </div>
      );
    });
}
