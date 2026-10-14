/** Read the original browser state on upgrade; new writes use the Tickgrove namespace. */
export function compatibleStorage(storage: Storage, legacyPrefix = "oc.") {
  const legacyKey = (key: string) =>
    key.startsWith("tickgrove.") ? legacyPrefix + key.slice("tickgrove.".length) : key;
  return {
    getItem(key: string) {
      const current = storage.getItem(key);
      if (current !== null) return current;
      const old = storage.getItem(legacyKey(key));
      if (old !== null) {
        try {
          storage.setItem(key, old);
        } catch {
          /* Read the legacy value even if storage is full. */
        }
      }
      return old;
    },
    setItem(key: string, value: string) {
      storage.setItem(key, value);
    },
    removeItem(key: string) {
      storage.removeItem(key);
      storage.removeItem(legacyKey(key));
    },
  };
}
