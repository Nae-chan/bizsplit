CREATE TABLE "shopify_product" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"title" text NOT NULL,
	"handle" text NOT NULL,
	"status" text NOT NULL,
	"product_type" text,
	"vendor" text,
	"image_url" text,
	"deleted_at" timestamp with time zone,
	"shopify_updated_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopify_variant" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"title" text NOT NULL,
	"sku" text,
	"position" integer DEFAULT 1 NOT NULL,
	"price_cents" integer NOT NULL,
	"deleted_at" timestamp with time zone,
	"shopify_updated_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variant_cost" (
	"id" text PRIMARY KEY NOT NULL,
	"variant_id" text NOT NULL,
	"unit_cost_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"note" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sync_job" RENAME COLUMN "orders_synced" TO "items_synced";--> statement-breakpoint
ALTER TABLE "sync_job" ALTER COLUMN "start_date" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "store_connection" ADD COLUMN "iana_timezone" text;--> statement-breakpoint
ALTER TABLE "sync_job" ADD COLUMN "kind" text DEFAULT 'orders' NOT NULL;--> statement-breakpoint
ALTER TABLE "shopify_product" ADD CONSTRAINT "shopify_product_connection_id_store_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."store_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_variant" ADD CONSTRAINT "shopify_variant_product_id_shopify_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."shopify_product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_cost" ADD CONSTRAINT "variant_cost_variant_id_shopify_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."shopify_variant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_cost" ADD CONSTRAINT "variant_cost_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shopify_product_connection_id_idx" ON "shopify_product" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "shopify_variant_product_id_idx" ON "shopify_variant" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "variant_cost_variant_id_effective_from_idx" ON "variant_cost" USING btree ("variant_id","effective_from");