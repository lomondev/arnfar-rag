import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Transactional outbox — kept as an append-only audit/event log. Inserted in the
 *  same txn as the state change it describes; never published inside a txn. With
 *  RabbitMQ dropped (decision B), nothing consumes it yet — it's here for audit and
 *  for the day a real out-of-process consumer appears. */
export const outboxEvent = pgTable(
  "outbox_event",
  {
    id: uuid("id").primaryKey(),
    hfId: uuid("hf_id").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("outbox_unpublished")
      .on(t.createdAt)
      .where(sql`published_at IS NULL`),
  ],
);
