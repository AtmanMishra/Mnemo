import { createContext, useContext, useSyncExternalStore } from "react";
import { SettingsStore, type Settings } from "../runtime/settings.ts";

/** The settings the interface reads. Defaults without a provider (tests render components alone). */
export const SettingsContext = createContext<SettingsStore>(new SettingsStore());

/** The current settings; the component draws again when one changes. */
export function useSettings(): Settings {
  const store = useContext(SettingsContext);
  return useSyncExternalStore(store.subscribe, store.get);
}
