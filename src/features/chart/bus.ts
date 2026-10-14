type Evt = { source: string; group: string; tf: string; time: number | null; price?: number }
const ls = new Set<(e: Evt) => void>()
export const crosshairBus = {
  emit: (e: Evt) => ls.forEach((l) => l(e)),
  on: (l: (e: Evt) => void) => {
    ls.add(l)
    return () => ls.delete(l)
  },
}

export function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}
export const chartControls=new Map<string,{fit:()=>void;screenshot:()=>void;focus:(time:number)=>void}>()
