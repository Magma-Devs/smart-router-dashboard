import { describe, expect, it } from "vitest";
import { isTopLayer, lockScroll, pushLayer, wrapFocus } from "../dialog-layer";

describe("layer stack", () => {
  it("gives Escape and the focus trap to the newest layer only", () => {
    const sheet = pushLayer();
    expect(isTopLayer(sheet.id)).toBe(true);

    const confirm = pushLayer();
    expect(isTopLayer(confirm.id)).toBe(true);
    expect(isTopLayer(sheet.id)).toBe(false);

    confirm.remove();
    expect(isTopLayer(sheet.id)).toBe(true);
    sheet.remove();
    expect(isTopLayer(sheet.id)).toBe(false);
  });

  it("drops a layer that closes out of order without disturbing the top one", () => {
    const below = pushLayer();
    const top = pushLayer();
    below.remove();
    expect(isTopLayer(top.id)).toBe(true);
    below.remove(); // a second removal is a no-op
    expect(isTopLayer(top.id)).toBe(true);
    top.remove();
  });
});

describe("lockScroll", () => {
  const body = () => ({ overflow: "", paddingRight: "" });

  it("stops the page scrolling and pads for the scrollbar it hides", () => {
    const style = body();
    const release = lockScroll(style, 15);
    expect(style).toEqual({ overflow: "hidden", paddingRight: "15px" });
    release();
    expect(style).toEqual({ overflow: "", paddingRight: "" });
  });

  it("adds no padding where the system overlays its scrollbar", () => {
    const style = body();
    const release = lockScroll(style, 0);
    expect(style).toEqual({ overflow: "hidden", paddingRight: "" });
    release();
  });

  it("stays locked until the last of two open layers closes", () => {
    const style = body();
    const sheet = lockScroll(style, 15);
    const confirm = lockScroll(style, 0);
    sheet();
    expect(style.overflow).toBe("hidden");
    confirm();
    expect(style).toEqual({ overflow: "", paddingRight: "" });
  });

  it("puts back the inline values the page had before", () => {
    const style = { overflow: "auto", paddingRight: "4px" };
    const release = lockScroll(style, 15);
    release();
    release(); // releasing twice does not unlock another layer's hold
    expect(style).toEqual({ overflow: "auto", paddingRight: "4px" });

    const a = lockScroll(style, 15);
    const b = lockScroll(style, 15);
    a();
    a();
    expect(style.overflow).toBe("hidden");
    b();
    expect(style.overflow).toBe("auto");
  });
});

describe("wrapFocus", () => {
  const dialog = "dialog";
  const items = ["close", "cancel", "save"];

  it("wraps from the last control to the first, and back", () => {
    expect(wrapFocus(items, "save", false, dialog)).toBe("close");
    expect(wrapFocus(items, "close", true, dialog)).toBe("save");
  });

  it("leaves the browser to move focus between the controls in the middle", () => {
    expect(wrapFocus(items, "close", false, dialog)).toBeNull();
    expect(wrapFocus(items, "cancel", false, dialog)).toBeNull();
    expect(wrapFocus(items, "save", true, dialog)).toBeNull();
  });

  it("enters at the first or the last control from the dialog itself or from nowhere", () => {
    expect(wrapFocus(items, dialog, false, dialog)).toBe("close");
    expect(wrapFocus(items, dialog, true, dialog)).toBe("save");
    expect(wrapFocus(items, null, false, dialog)).toBe("close");
    expect(wrapFocus(items, null, true, dialog)).toBe("save");
  });

  it("keeps focus on a dialog with no control to Tab to", () => {
    expect(wrapFocus([], null, false, dialog)).toBe(dialog);
    expect(wrapFocus([], dialog, true, dialog)).toBe(dialog);
  });

  it("wraps onto itself in a dialog with one control", () => {
    expect(wrapFocus(["close"], "close", false, dialog)).toBe("close");
    expect(wrapFocus(["close"], "close", true, dialog)).toBe("close");
  });
});
