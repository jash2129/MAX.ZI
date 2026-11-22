import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PanelView } from "../src/app/c/[dealership]/room";
import type { Product } from "../src/server/callpage";

const approved: Product[] = [{ key: "vsc", title: "10-Year / 100,000-Mile Bumper-to-Bumper", bullets: ["Engine and transmission", "Zero deductible"] }];
const product = (products: Product[]) => (k: string): Product => products.find((p) => p.key === k) ?? { key: k, title: `default:${k}` };
const html = (panel: any, products: Product[] = [], rate: number | null = null) =>
  renderToStaticMarkup(<PanelView panel={panel} product={product(products)} rate={rate} vehicle="2026 Mazda CX-30" dealershipName="Mazda Dealership" />);

describe("customer panels", () => {
  it("the price panel shows only the rate Max is saying now", () => {
    const h = html({ panel: "price", data: { daily_rate: 3.5 } });
    expect(h).toContain("$3.50");
    expect(h).not.toMatch(/\$4|\$3\.25|\$3\.00/);
  });

  it("coverage terms come only from the dealership's approved products; otherwise titles only", () => {
    const withTerms = html({ panel: "coverage_grid", data: { product: "vsc" } }, approved);
    expect(withTerms).toContain("10-Year / 100,000-Mile Bumper-to-Bumper");
    expect(withTerms).toContain("Zero deductible");
    const titlesOnly = html({ panel: "coverage_grid", data: { product: "vsc" } });
    expect(titlesOnly).toContain("default:vsc");
    expect(titlesOnly).not.toMatch(/Year|deductible|\$/);
  });

  it("the summary shows the vehicle, the package and the agreed rate", () => {
    const h = html({ panel: "deal_summary", data: {} }, approved, 3.25);
    expect(h).toContain("2026 Mazda CX-30");
    expect(h).toContain("$3.25 a day");
  });

  it("other panels show their approved title and terms", () => {
    expect(html({ panel: "warranty_terms", data: {} }, [{ key: "warranty_terms", title: "Factory warranty: 5 years / 60,000 miles" }])).toContain("5 years / 60,000 miles");
  });
});
