export const SHOP_QUERY = /* GraphQL */ `
  query BizsplitShopInfo {
    shop {
      name
      myshopifyDomain
      currencyCode
      ianaTimezone
    }
  }
`;

export const ORDERS_PAGE_QUERY = /* GraphQL */ `
  query BizsplitOrdersPage($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        name
        createdAt
        updatedAt
        currencyCode
        displayFinancialStatus
        subtotalPriceSet {
          shopMoney {
            amount
          }
        }
        totalDiscountsSet {
          shopMoney {
            amount
          }
        }
        totalShippingPriceSet {
          shopMoney {
            amount
          }
        }
        totalTaxSet {
          shopMoney {
            amount
          }
        }
        totalPriceSet {
          shopMoney {
            amount
          }
        }
        lineItems(first: 50) {
          nodes {
            id
            title
            quantity
            product {
              id
            }
            variant {
              id
            }
            originalUnitPriceSet {
              shopMoney {
                amount
              }
            }
            discountedTotalSet {
              shopMoney {
                amount
              }
            }
          }
        }
        transactions {
          kind
          status
          fees {
            amount {
              amount
            }
          }
        }
      }
    }
  }
`;

/** Selection shared by the catalog page query and the single-product webhook fetch. */
const PRODUCT_FIELDS_FRAGMENT = /* GraphQL */ `
  fragment BizsplitProductFields on Product {
    id
    title
    handle
    status
    productType
    vendor
    updatedAt
    featuredImage {
      url
    }
    variants(first: 100) {
      pageInfo {
        hasNextPage
      }
      nodes {
        id
        title
        sku
        position
        price
        updatedAt
      }
    }
  }
`;

export const PRODUCTS_PAGE_QUERY = /* GraphQL */ `
  query BizsplitProductsPage($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        ...BizsplitProductFields
      }
    }
  }
  ${PRODUCT_FIELDS_FRAGMENT}
`;

/** Single product re-fetch for the products/create and products/update webhooks. */
export const PRODUCT_BY_ID_QUERY = /* GraphQL */ `
  query BizsplitProductById($id: ID!) {
    product(id: $id) {
      ...BizsplitProductFields
    }
  }
  ${PRODUCT_FIELDS_FRAGMENT}
`;

export const WEBHOOK_CREATE_MUTATION = /* GraphQL */ `
  mutation BizsplitWebhookCreate($topic: WebhookSubscriptionTopic!, $callbackUrl: URL!) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: { callbackUrl: $callbackUrl, format: JSON }
    ) {
      webhookSubscription {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;
