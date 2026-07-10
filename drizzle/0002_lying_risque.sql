CREATE TABLE "shopify_order" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"order_number" text NOT NULL,
	"placed_at" timestamp with time zone NOT NULL,
	"currency" text NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"discounts_cents" integer DEFAULT 0 NOT NULL,
	"shipping_cents" integer DEFAULT 0 NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer NOT NULL,
	"fees_cents" integer,
	"financial_status" text NOT NULL,
	"shopify_updated_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopify_order_line" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"product_id" text,
	"variant_id" text,
	"title" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"discounted_total_cents" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"shop_domain" text NOT NULL,
	"shop_name" text NOT NULL,
	"encrypted_client_id" text NOT NULL,
	"encrypted_client_secret" text NOT NULL,
	"encrypted_access_token" text,
	"token_expires_at" timestamp with time zone,
	"currency" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_connection_shop_domain_unique" UNIQUE("shop_domain")
);
--> statement-breakpoint
CREATE TABLE "sync_job" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"start_date" timestamp with time zone NOT NULL,
	"cursor" text,
	"status" text DEFAULT 'running' NOT NULL,
	"orders_synced" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shopify_order" ADD CONSTRAINT "shopify_order_connection_id_store_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."store_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_order_line" ADD CONSTRAINT "shopify_order_line_order_id_shopify_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."shopify_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_connection" ADD CONSTRAINT "store_connection_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_job" ADD CONSTRAINT "sync_job_connection_id_store_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."store_connection"("id") ON DELETE cascade ON UPDATE no action;