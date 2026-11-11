import { FileInput } from "lucide-react";
import type { KubeconfigOffer, KubeconfigOfferId } from "@twigo/protocol";
import { notify } from "@twigo/ui";
import { OfferDetail } from "./OfferDetail";
import { describeOffer } from "./offerWords";
import type { KubeconfigOffers } from "./offers";
import type { TerminalTabs } from "./tabs";

/**
 * Shows each offer that no tab shows as a toast that stays until it is
 * answered, and takes it down when it is answered or withdrawn. `barred`
 * says whether a tab shows an offer, which follows the open tabs too.
 */
export function presentOffers(
  offers: KubeconfigOffers,
  tabs: TerminalTabs,
  barred: (offer: KubeconfigOffer) => boolean,
): void {
  const shown = new Map<
    KubeconfigOfferId,
    { offer: KubeconfigOffer; busy: boolean; dismiss: () => void }
  >();
  const sync = () => {
    const wanted = offers.offers.filter((offer) => !barred(offer));
    for (const [id, toast] of shown) {
      if (wanted.some((offer) => offer.id === id)) continue;
      toast.dismiss();
      shown.delete(id);
    }
    for (const offer of wanted) {
      const busy = offers.answering(offer.id);
      const last = shown.get(offer.id);
      if (last?.offer === offer && last.busy === busy) continue;
      const words = describeOffer(offer);
      const { dismiss } = notify.choice(
        {
          icon: FileInput,
          message: words.title,
          detail: <OfferDetail words={words} />,
          choices: [
            {
              label: words.move,
              run: () => {
                void offers.answer(offer.id, "move");
              },
            },
            {
              label: "Dismiss",
              run: () => {
                void offers.answer(offer.id, "dismiss");
              },
            },
          ],
          busy,
        },
        `kubeconfig-offer-${String(offer.id)}`,
      );
      shown.set(offer.id, { offer, busy, dismiss });
    }
  };
  offers.changes.subscribe(sync);
  tabs.changes.subscribe(sync);
}
