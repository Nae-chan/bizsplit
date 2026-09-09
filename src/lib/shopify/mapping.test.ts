import { describe, expect, it } from "vitest";
import {
  extractFeesCents,
  mapOrderNode,
  mapProductNode,
  type ShopifyOrderNode,
  type ShopifyProductNode,
} from "./mapping";

const baseOrder: ShopifyOrderNode = {
  id: "gid://shopify/Order/1001",
  name: "#1001",
  createdAt: "2026-07-01T12:00:00Z",
  updatedAt: "2026-07-01T12:05:00Z",
  currencyCode: "USD",
  displayFinancialStatus: "PAID",
  subtotalPriceSet: { shopMoney: { amount: "45.00" } },
  totalDiscountsSet: { shopMoney: { amount: "5.00" } },
  totalShippingPriceSet: { shopMoney: { amount: "7.99" } },
  totalTaxSet: { shopMoney: { amount: "3.15" } },
  totalPriceSet: { shopMoney: { amount: "51.14" } },
  lineItems: {
    nodes: [
      {
        id: "gid://shopify/LineItem/1",
        title: "Rip Tee",
        quantity: 2,
        product: { id: "gid://shopify/Product/9" },
        variant: { id: "gid://shopify/ProductVariant/99" },
        originalUnitPriceSet: { shopMoney: { amount: "22.50" } },
        discountedTotalSet: { shopMoney: { amount: "40.00" } },
      },
    ],
  },
  transactions: [{ kind: "SALE", status: "SUCCESS", fees: [{ amount: { amount: "1.78" } }] }],
};

describe("mapOrderNode", () => {
  it("converts all money fields to integer cents", () => {
    const { order, lines } = mapOrderNode(baseOrder, "conn-1");
    expect(order.subtotalCents).toBe(4500);
    expect(order.discountsCents).toBe(500);
    expect(order.shippingCents).toBe(799);
    expect(order.taxCents).toBe(315);
    expect(order.totalCents).toBe(5114);
    expect(order.feesCents).toBe(178);
    expect(lines[0].unitPriceCents).toBe(2250);
    expect(lines[0].discountedTotalCents).toBe(4000);
    expect(lines[0].productId).toBe("gid://shopify/Product/9");
  });

  it("handles line items whose product was deleted", () => {
    const node = {
      ...baseOrder,
      lineItems: { nodes: [{ ...baseOrder.lineItems.nodes[0], product: null, variant: null }] },
    };
    const { lines } = mapOrderNode(node, "conn-1");
    expect(lines[0].productId).toBeNull();
  });
});

describe("extractFeesCents (ADR-0005 fee-hold)", () => {
  it("returns null when no transaction reports fees yet", () => {
    expect(extractFeesCents([{ kind: "SALE", status: "SUCCESS", fees: [] }])).toBeNull();
    expect(extractFeesCents([])).toBeNull();
  });

  it("ignores failed transactions", () => {
    expect(
      extractFeesCents([
        { kind: "SALE", status: "FAILURE", fees: [{ amount: { amount: "9.99" } }] },
        { kind: "SALE", status: "SUCCESS", fees: [{ amount: { amount: "1.50" } }] },
      ]),
    ).toBe(150);
  });

  it("sums fees across multiple successful transactions", () => {
    expect(
      extractFeesCents([
        { kind: "SALE", status: "SUCCESS", fees: [{ amount: { amount: "1.00" } }] },
        { kind: "CAPTURE", status: "SUCCESS", fees: [{ amount: { amount: "0.30" } }] },
      ]),
    ).toBe(130);
  });
});

const baseProduct: ShopifyProductNode = {
  id: "gid://shopify/Product/9",
  title: "Rip Tee",
  handle: "rip-tee",
  status: "ACTIVE",
  productType: "Shirts",
  vendor: "Ripright",
  updatedAt: "2026-07-01T12:05:00Z",
  featuredImage: { url: "https://cdn.shopify.com/rip-tee.png" },
  variants: {
    pageInfo: { hasNextPage: false },
    nodes: [
      {
        id: "gid://shopify/ProductVariant/99",
        title: "Black / L",
        sku: "RIP-BLK-L",
        position: 1,
        price: "22.50",
        updatedAt: "2026-07-01T12:05:00Z",
      },
    ],
  },
};

describe("mapProductNode", () => {
  it("converts prices to integer cents and dates to Date", () => {
    const { product, variants } = mapProductNode(baseProduct);
    expect(product.id).toBe("gid://shopify/Product/9");
    expect(product.status).toBe("ACTIVE");
    expect(product.imageUrl).toBe("https://cdn.shopify.com/rip-tee.png");
    expect(product.shopifyUpdatedAt.toISOString()).toBe("2026-07-01T12:05:00.000Z");
    expect(variants[0].priceCents).toBe(2250);
    expect(Number.isInteger(variants[0].priceCents)).toBe(true);
    expect(variants[0].sku).toBe("RIP-BLK-L");
    expect(variants[0].position).toBe(1);
  });

  it("maps missing sku, productType, vendor and image to null", () => {
    const { product, variants } = mapProductNode({
      ...baseProduct,
      productType: null,
      vendor: null,
      featuredImage: null,
      variants: {
        pageInfo: { hasNextPage: false },
        nodes: [{ ...baseProduct.variants.nodes[0], sku: null }],
      },
    });
    expect(product.productType).toBeNull();
    expect(product.vendor).toBeNull();
    expect(product.imageUrl).toBeNull();
    expect(variants[0].sku).toBeNull();
  });

  it("maps a product with no variants to an empty array", () => {
    const mapped = mapProductNode({
      ...baseProduct,
      variants: { pageInfo: { hasNextPage: false }, nodes: [] },
    });
    expect(mapped.variants).toEqual([]);
    expect(mapped.hasMoreVariants).toBe(false);
  });

  it("flags products with more than the 100 variants we fetch", () => {
    const mapped = mapProductNode({
      ...baseProduct,
      variants: { pageInfo: { hasNextPage: true }, nodes: baseProduct.variants.nodes },
    });
    expect(mapped.hasMoreVariants).toBe(true);
  });

  it("handles a zero price", () => {
    const mapped = mapProductNode({
      ...baseProduct,
      variants: {
        pageInfo: { hasNextPage: false },
        nodes: [{ ...baseProduct.variants.nodes[0], price: "0.00" }],
      },
    });
    expect(mapped.variants[0].priceCents).toBe(0);
  });
});
