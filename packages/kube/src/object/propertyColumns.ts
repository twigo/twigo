import { createContext, useContext } from "react";

/** How many columns a page lays its property rows in: two on the full page. */
export const PropertyColumns = createContext<1 | 2>(1);

export const usePropertyColumns = (): 1 | 2 => useContext(PropertyColumns);
