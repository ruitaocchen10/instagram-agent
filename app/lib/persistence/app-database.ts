import Database from "@tauri-apps/plugin-sql";

const DATABASE_URL = "sqlite:app.db";

let databasePromise: Promise<Database> | null = null;

// Posts and conversations share one connection and one migration run. A failed
// open remains retryable instead of poisoning the cached promise for the rest
// of the application session.
export async function appDatabase(): Promise<Database> {
  if (!databasePromise) databasePromise = Database.load(DATABASE_URL);
  try {
    return await databasePromise;
  } catch (error) {
    databasePromise = null;
    throw error;
  }
}

export async function inTransaction<T>(operation: () => Promise<T>): Promise<T> {
  const connection = await appDatabase();
  await connection.execute("BEGIN IMMEDIATE");
  try {
    const result = await operation();
    await connection.execute("COMMIT");
    return result;
  } catch (error) {
    try {
      await connection.execute("ROLLBACK");
    } catch {
      // Preserve the operation error; it explains why the transaction failed.
    }
    throw error;
  }
}
