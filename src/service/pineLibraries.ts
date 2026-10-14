import type { PineLibraryLock } from "../pine/library";
import type { PineRunOptions } from "../pine/runtime";
import { command, getServiceToken } from "./client";

// References are immutable; source + authenticated instance determine the lock.
const locks = new Map<string, Promise<PineLibraryLock>>();
export async function resolvePineOptions(
  source: string,
  options: PineRunOptions,
): Promise<PineRunOptions> {
  if (!/^\s*import\s+/m.test(source)) return options;
  const key = getServiceToken() + "\n" + source;
  let pending = locks.get(key);
  if (!pending) {
    pending = command<PineLibraryLock>("pine.resolve", { source }).catch((error) => {
      locks.delete(key);
      throw error;
    });
    locks.set(key, pending);
    if (locks.size > 100) locks.delete(locks.keys().next().value!);
  }
  return { ...options, libraryLock: await pending };
}
