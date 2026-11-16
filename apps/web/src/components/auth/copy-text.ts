/** What `copyText` writes with. Both are the browser's unless a test passes its own. */
export interface CopyDeps {
  /** The Clipboard API, absent on a page served over plain http. */
  clipboard?: Pick<Clipboard, "writeText">;
  /** Copies by selecting a hidden textarea; true when the browser says it copied. */
  select?: (text: string) => boolean;
}

/**
 * Copies `text` and says whether it worked: through the Clipboard API where
 * the page may use it, else by selecting a hidden textarea, which also works
 * where the page is not a secure context.
 */
export async function copyText(text: string, deps: CopyDeps = {}): Promise<boolean> {
  const clipboard = "clipboard" in deps ? deps.clipboard : globalThis.navigator?.clipboard;
  const select = deps.select ?? selectAndCopy;
  if (clipboard) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Refused (no permission, the document not focused): try the textarea.
    }
  }
  return select(text);
}

function selectAndCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
