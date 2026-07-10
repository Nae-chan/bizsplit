import { decimalToCents } from "@/lib/money";

/** Shapes returned by ORDERS_PAGE_QUERY (the parts we consume). */
export interface ShopifyOrderNode {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  currencyCode: string;
  displayFinancialStatus: string | null;
  subtotalPriceSet: MoneySet;
  totalDiscountsSet: MoneySet;
  totalShippingPriceSet: MoneySet;
  totalTaxSet: MoneySet;
  totalPriceSet: MoneySet;
  lineItems: { nodes: ShopifyLineItemNode[] };
  transactions: ShopifyTransactionNode[];
}
interface MoneySet {
  shopMoney: { amount: string };
}
interface ShopifyLineItemNode {
  id: string;
  title: string;
  quantity: number;
  product: { id: string } | null;
  variant: { id: string } | null;
  originalUnitPriceSet: MoneySet;
  discountedTotalSet: MoneySet;
}
interface ShopifyTransactionNode {
  kind: string;
  status: string;
  fees: Array<{ amount: { amount: string } }>;
}

export interface MappedOrder {
  order: {
    id: string;
    orderNumber: string;
    placedAt: Date;
    currency: string;
    subtotalCents: number;
    discountsCents: number;
    shippingCents: number;
    taxCents: number;
    totalCents: number;
    feesCents: number | null;
    financialStatus: string;
    shopifyUpdatedAt: Date;
  };
  lines: Array<{
    id: string;
    productId: string | null;
    variantId: string | null;
    title: string;
    quantity: number;
    unitPriceCents: number;
    discountedTotalCents: number;
  }>;
}

/**
 * Actual gateway fees for an order: sum fees across successful transactions.
 * Returns null when no successful transaction reports fees yet — the
 * "fees pending" state that blocks settlement finalization (ADR-0005).
 */
export function extractFeesCents(transactions: ShopifyTransactionNode[]): number | null {
  const successful = transactions.filter((t) => t.status === "SUCCESS");
  const withFees = successful.filter((t) => t.fees.length > 0);
  if (withFees.length === 0) return null;
  return withFees
    .flatMap((t) => t.fees)
    .reduce((sum, f) => sum + decimalToCents(f.amount.amount), 0);
}

export function mapOrderNode(node: ShopifyOrderNode, connectionId: string): MappedOrder {
  void connectionId; // reserved for future validation/logging context
  return {
    order: {
      id: node.id,
      orderNumber: node.name,
      placedAt: new Date(node.createdAt),
      currency: node.currencyCode,
      subtotalCents: decimalToCents(node.subtotalPriceSet.shopMoney.amount),
      discountsCents: decimalToCents(node.totalDiscountsSet.shopMoney.amount),
      shippingCents: decimalToCents(node.totalShippingPriceSet.shopMoney.amount),
      taxCents: decimalToCents(node.totalTaxSet.shopMoney.amount),
      totalCents: decimalToCents(node.totalPriceSet.shopMoney.amount),
      feesCents: extractFeesCents(node.transactions),
      financialStatus: node.displayFinancialStatus ?? "UNKNOWN",
      shopifyUpdatedAt: new Date(node.updatedAt),
    },
    lines: node.lineItems.nodes.map((li) => ({
      id: li.id,
      productId: li.product?.id ?? null,
      variantId: li.variant?.id ?? null,
      title: li.title,
      quantity: li.quantity,
      unitPriceCents: decimalToCents(li.originalUnitPriceSet.shopMoney.amount),
      discountedTotalCents: decimalToCents(li.discountedTotalSet.shopMoney.amount),
    })),
  };
}
