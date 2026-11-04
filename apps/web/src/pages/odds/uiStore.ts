import { create } from "zustand";

/** Which of the board's overlays is open, shared so a header can open them too. */
export const useOddsUi = create<{ positionsOpen: boolean; howOpen: boolean }>(() => ({ positionsOpen: false, howOpen: false }));

export const openPositions = (open = true) => useOddsUi.setState({ positionsOpen: open });
export const openHow = (open = true) => useOddsUi.setState({ howOpen: open });
