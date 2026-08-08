import type { DatabaseHandle } from "../db/client.js";
import { cleanupTerminalExternalMutations } from "../operations/external-mutation-journal.js";

export const SAVED_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1_000;
export const SAVED_OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const SAVED_MAINTENANCE_BATCH_SIZE = 100;

export interface SavedMaintenanceResult {
  catalogItems: number;
  lists: number;
  lifecycleMismatches: number;
  operations: number;
  targets: number;
}

export function purgeExpiredSavedState(
  database: DatabaseHandle,
  now: number,
  batchSize = SAVED_MAINTENANCE_BATCH_SIZE,
): SavedMaintenanceResult {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new TypeError("Saved maintenance requires a valid clock and positive batch size.");
  }
  return database.sqlite
    .transaction(() => {
      const lists = database.sqlite
        .prepare(
          `delete from saved_lists where id in (
             select id from saved_lists
             where kind = 'custom' and deleted_at is not null and undo_expires_at <= ?
               and not exists (
                 select 1 from saved_list_operations operation
                 where operation.resource_id = saved_lists.id
                   and operation.state not in ('succeeded', 'failed')
               )
             order by undo_expires_at, id limit ?
           )`,
        )
        .run(now, batchSize).changes;
      const targets = database.sqlite
        .prepare(
          `delete from saved_targets where id in (
             select id from saved_targets where expires_at <= ?
               and not exists (
                 select 1 from saved_list_operations operation
                 where operation.resource_id = saved_targets.id
                   and operation.state not in ('succeeded', 'failed')
               )
             order by expires_at, id limit ?
           )`,
        )
        .run(now, batchSize).changes;
      const lifecycle = cleanupTerminalExternalMutations(database.sqlite, {
        completedBefore: now - SAVED_OPERATION_RETENTION_MS,
        limit: batchSize,
        parentOperationType: "saved_list_operation",
      });
      const operations = lifecycle.parents;
      const catalogItems = database.sqlite
        .prepare(
          `delete from saved_catalog_items where id in (
             select saved_catalog_items.id from saved_catalog_items
             where not exists (
               select 1 from saved_list_items
               where saved_list_items.catalog_item_id = saved_catalog_items.id
                 and saved_list_items.user_id = saved_catalog_items.user_id
             )
             order by saved_catalog_items.updated_at, saved_catalog_items.id limit ?
           )`,
        )
        .run(batchSize).changes;
      return {
        catalogItems,
        lifecycleMismatches: lifecycle.mismatchedParents,
        lists,
        operations,
        targets,
      };
    })
    .immediate();
}
