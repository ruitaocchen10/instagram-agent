import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { LocalMediaSource, PostMedia } from "./types";

export type R2Jurisdiction = "default" | "eu";

export interface R2Config {
  accountId: string;
  bucketName: string;
  jurisdiction: R2Jurisdiction;
  lifecycleAcknowledged: boolean;
}

export interface R2Status {
  configured: boolean;
  config: R2Config | null;
  maskedAccessKeyId: string | null;
  error: string | null;
}

interface ManagedMediaResult extends LocalMediaSource {
  localPath: string;
}

export interface SelectedLocalMedia {
  source: LocalMediaSource;
  previewUrl: string;
}

export interface StagedMedia {
  objectKey: string;
  publicUrl: string;
}

export interface ReelUploadProgress {
  assetId: string;
  uploaded: number;
  total: number;
}

export function getR2Status(): Promise<R2Status> {
  return invoke<R2Status>("get_r2_status");
}

export function configureR2(
  config: R2Config,
  accessKeyId: string,
  secretAccessKey: string,
): Promise<R2Status> {
  return invoke<R2Status>("configure_r2", { config, accessKeyId, secretAccessKey });
}

export function testR2Connection(): Promise<void> {
  return invoke("test_r2_connection");
}

export function disconnectR2(): Promise<void> {
  return invoke("disconnect_r2");
}

export async function chooseLocalMedia(type: PostMedia["type"]): Promise<SelectedLocalMedia | null> {
  const result = await invoke<ManagedMediaResult | null>("choose_local_media", {
    mediaType: type,
  });
  if (!result) return null;
  const { localPath, ...source } = result;
  return { source, previewUrl: convertFileSrc(localPath) };
}

export async function previewUrlForLocalMedia(assetId: string): Promise<string> {
  const path = await invoke<string>("managed_media_path_for_preview", { assetId });
  return convertFileSrc(path);
}

export function deleteManagedMedia(assetId: string): Promise<void> {
  return invoke("delete_managed_media", { assetId });
}

export function materializeManagedMediaCopy(assetId: string): Promise<void> {
  return invoke("materialize_managed_media_copy", { assetId });
}

export function cleanupOrphanedManagedMedia(retainedAssetIds: string[]): Promise<number> {
  return invoke<number>("cleanup_orphaned_managed_media", { retainedAssetIds });
}

export function stageLocalImage(assetId: string, instagramUserId: string): Promise<StagedMedia> {
  return invoke<StagedMedia>("stage_local_image", { assetId, instagramUserId });
}

export function deleteStagedMedia(objectKey: string): Promise<void> {
  return invoke("delete_staged_media", { objectKey });
}

export function cancelLocalReelUpload(assetId: string): Promise<void> {
  return invoke("cancel_local_reel_upload", { assetId });
}

export function onReelUploadProgress(
  handler: (progress: ReelUploadProgress) => void,
): Promise<UnlistenFn> {
  return listen<ReelUploadProgress>("reel-upload-progress", (event) => handler(event.payload));
}
