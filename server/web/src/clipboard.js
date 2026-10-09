/** Copies `text`; resolves to false when the browser refuses. The Clipboard API is missing outside HTTPS and localhost. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the selection-based copy.
  }
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(field);
  const opener = document.activeElement;
  field.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
    opener?.focus?.();
  }
}
