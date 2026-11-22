/**
 * The controller's tool calls (the names the Tavus/HeyGen demo used) mapped to the platform's panel
 * events (PRD "Data channel events"). The voice worker forwards these to the browser unchanged.
 */
export type PanelEvent =
  | { event: "panel.show"; panel: PanelName; data: Record<string, unknown> }
  | { event: "panel.hide" };

export type PanelName = "warranty_terms" | "repair_costs" | "coverage_grid" | "price" | "deal_summary";

const CONTENT_ITEMS: Record<string, PanelName> = {
  warranty_terms: "warranty_terms",
  cost_breakdown: "repair_costs",
  deal_summary: "deal_summary",
};

export function toPanelEvents(toolCalls: Array<{ name: string; args: Record<string, any> }> = []): PanelEvent[] {
  const out: PanelEvent[] = [];
  for (const call of toolCalls) {
    switch (call.name) {
      case "show_content": {
        const panel = CONTENT_ITEMS[String(call.args?.item)];
        if (panel) out.push({ event: "panel.show", panel, data: {} });
        break;
      }
      case "draw_grid_outline":
        out.push({ event: "panel.show", panel: "coverage_grid", data: {} });
        break;
      case "show_pricing":
        out.push({ event: "panel.show", panel: "coverage_grid", data: { product: String(call.args?.product ?? "") } });
        break;
      case "show_payment_breakdown": {
        // Only the single rate Max is saying now, never the ladder (PRD panel rule)
        const rate = Number(call.args?.daily_rate);
        if (Number.isFinite(rate)) out.push({ event: "panel.show", panel: "price", data: { daily_rate: rate } });
        break;
      }
      case "dismiss_content":
        out.push({ event: "panel.hide" });
        break;
      default:
        // Unknown tool names are dropped, never shown raw
        break;
    }
  }
  return out;
}
