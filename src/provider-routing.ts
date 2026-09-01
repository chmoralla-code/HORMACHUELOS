/**
 * A hosted catalog can advertise a built-in provider without owning its BYOK
 * endpoint. Preserve that provider's installed direct URL; the Rust request
 * router decides at run time whether a missing local key should use the hosted
 * proxy instead.
 */
export function hostedCatalogDefaultBaseUrl(
  builtinDefaultBaseUrl: string | null | undefined,
  hostedProxyBaseUrl: string,
): string {
  return String(builtinDefaultBaseUrl || "").trim() || hostedProxyBaseUrl;
}
