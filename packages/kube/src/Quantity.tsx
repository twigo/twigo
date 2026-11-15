import { splitQuantity } from "@twigo/utils";

/** A quantity, such as `120m`, with its unit quiet beside its number. */
export function Quantity({ text }: { text: string }) {
  const [number, unit] = splitQuantity(text);
  return (
    <>
      {number}
      {unit !== "" && <span className="text-quiet">{unit}</span>}
    </>
  );
}
