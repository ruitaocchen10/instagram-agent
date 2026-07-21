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
