import { FileInput } from "lucide-react";
import type { KubeconfigOffer, KubeconfigOfferId } from "@twigo/protocol";
import { notify } from "@twigo/ui";
import { OfferDetail } from "./OfferDetail";
import { describeOffer } from "./offerWords";
import type { KubeconfigOffers } from "./offers";

/**
 * Shows each offer as a toast that stays until it is answered, and takes it
 * down when it is answered or withdrawn.
 */
export function presentOffers(offers: KubeconfigOffers): void {
  const shown = new Map<
    KubeconfigOfferId,
    { offer: KubeconfigOffer; busy: boolean; dismiss: () => void }
  >();
  const sync = () => {
    for (const [id, toast] of shown) {
      if (offers.offers.some((offer) => offer.id === id)) continue;
      toast.dismiss();
      shown.delete(id);
    }
    for (const offer of offers.offers) {
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
}
