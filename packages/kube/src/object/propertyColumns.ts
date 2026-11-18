import { createContext, useContext } from "react";

/** How many columns a page lays its property rows in: two where the full page's column is wide enough. */
export const PropertyColumns = createContext<1 | 2>(1);

export const usePropertyColumns = (): 1 | 2 => useContext(PropertyColumns);
