// How a definition-list row is shown to users (docs/onay-sistemi.md, section 6, "Gösterim"): the code, and
// its name or description after an en dash when that says something more. Pure.

/** "P34MHG325 – P34MHG325-18036470"; just the code when the name is empty or the same as the code. */
export function display(kod: string, ad: string | null | undefined): string {
  const name = ad?.trim() ?? '';
  return name === '' || name === kod ? kod : `${kod} – ${name}`;
}
