export interface R2SetupFields {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
  lifecycleAcknowledged: boolean;
}

export function r2SetupReady(fields: R2SetupFields): boolean {
  return Boolean(
    fields.accountId.trim() &&
      fields.bucketName.trim() &&
      fields.accessKeyId.trim() &&
      fields.secretAccessKey.trim() &&
      fields.lifecycleAcknowledged,
  );
}
