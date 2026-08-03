import { create } from "zustand";

interface InterfaceState {
  operationsExpanded: boolean;
  setOperationsExpanded: (expanded: boolean) => void;
  toggleOperationsExpanded: () => void;
}

export const useInterfaceStore = create<InterfaceState>((set) => ({
  operationsExpanded: false,
  setOperationsExpanded: (operationsExpanded) => set({ operationsExpanded }),
  toggleOperationsExpanded: () =>
    set((state) => ({ operationsExpanded: !state.operationsExpanded })),
}));
