export interface MarketItemLike {
  id: string
  name: string
  installed?: boolean
}

export function isMarketItemInstalled(item: MarketItemLike, installedNames: ReadonlySet<string>): boolean {
  if (item.installed === true) return true
  return installedNames.has(item.name)
}

export function filterInstallableMarketItems<T extends MarketItemLike>(
  items: readonly T[],
  installedNames: ReadonlySet<string>,
): T[] {
  return items.filter((item) => !isMarketItemInstalled(item, installedNames))
}
