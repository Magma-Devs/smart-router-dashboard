import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/metrics",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const { AskProvider, useAsk } = await import("../AskProvider");

function Probe() {
  const ask = useAsk();
  return createElement(
    "output",
    null,
    JSON.stringify({ visible: ask.visible, shared: ask.shared }),
  );
}
const render = (props: { enabled: boolean; guest?: boolean }) =>
  JSON.parse(
    renderToStaticMarkup(createElement(AskProvider, { ...props, children: createElement(Probe) }))
      .replace(/^<output>|<\/output>$/g, "")
      .replace(/&quot;/g, '"'),
  ) as { visible: boolean; shared: boolean };

describe("AskProvider with accounts off", () => {
  it("shows Ask to the shared guest with no signed-in person, and says the history is shared", () => {
    expect(render({ enabled: true, guest: true })).toEqual({ visible: true, shared: true });
  });
  it("without the guest, no signed-in person sees no Ask", () => {
    expect(render({ enabled: true })).toEqual({ visible: false, shared: false });
  });
});
