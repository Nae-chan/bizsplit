export const SHOP_QUERY = /* GraphQL */ `
  query BizsplitShopInfo {
    shop {
      name
      myshopifyDomain
      currencyCode
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
